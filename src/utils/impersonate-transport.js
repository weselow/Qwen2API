/**
 * Impersonating TLS transport for POST /api/v2/chat/completions.
 *
 * Why this exists (proven live 2026-11-21, docs/et0-live-integration-2026-11-21.md):
 * completions from plain Node TLS — axios http1.1 AND native http2 — are
 * Baxia-punished (FAIL_SYS_USER_VALIDATE / RGV587 punish page). The same
 * request, same token, same cookies and FE headers sent through
 * curl-impersonate v0.6.1 (Chrome ClientHello + HTTP/2) returns 200 SSE with
 * the model answer. The TLS fingerprint is the lever, not the headers.
 *
 * We spawn the `curl-impersonate-chrome` BINARY directly, not the
 * `curl_chrome116` wrapper shipped in the same tarball. The wrapper prepends
 * its own Chrome-116 default headers (User-Agent, Accept, sec-ch-ua, ...) and
 * curl 8.1.1 sends BOTH copies when the caller passes its own (measured on the
 * wire: two User-Agent headers). The binary plus the wrapper's TLS flags
 * replicated below in CHROME116_TLS_FLAGS gives the same fingerprint with a
 * single, per-account header set.
 *
 * The binary is statically linked (libcurl-impersonate + BoringSSL + nghttp2 are
 * baked in; only libc/libz/libpthread are dynamic), so the Docker image ships
 * just the one file — pinned tarballs with sha256 verification, see
 * docker/Dockerfile.
 *
 * Secrets (Authorization, cookie) travel via argv by design; they must never
 * reach logs or thrown errors. Every string that can escape this module passes
 * redactImpersonateText() first, which masks URL credentials and blanks the
 * exact secret values of the request on top.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const axios = require('axios')
const config = require('../config/index.js')
const { logger } = require('./logger')

// Chrome-116 TLS profile, replicated verbatim from curl_chrome116 of the
// curl-impersonate v0.6.1 tarball (release pinned; re-pin together with the
// Dockerfile sha256 if this ever moves). --compressed keeps SSE bodies
// readable: the FE accept-encoding (gzip, deflate, br, zstd) rides in our own
// -H and curl still auto-decodes the response.
const CHROME116_CIPHERS = [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA'
].join(',')
const CHROME116_TLS_FLAGS = [
    '--ciphers', CHROME116_CIPHERS,
    '--compressed',
    '--tlsv1.2', '--alps', '--tls-permute-extensions',
    '--cert-compression', 'brotli'
]

// HTTP version flags, chosen per URL scheme. Over https, --http2 rides ALPN
// exactly like the live-proven capture. Over plain http, --http2 makes curl
// open with an h2c upgrade (Connection: Upgrade + HTTP2-Settings) that Bun's
// http server — the basis of the CI smoke stub — never answers, so the request
// hangs until --max-time (Qwen2API-73u). The real upstream is always https;
// plain http only ever faces local stubs, and with no TLS layer there is no
// fingerprint to preserve, so it gets pinned to HTTP/1.1.
const HTTPS_VERSION_FLAGS = ['--http2', '--http2-no-server-push']
const HTTP_VERSION_FLAGS = ['--http1.1']

// Hop-by-hop / HTTP/1-only headers that must not ride an HTTP/2 request: the
// FE header profile sets `connection: keep-alive` for the axios path, but a
// real Chrome sends none of these over h2 and curl would forward them as
// ordinary (and malformed) headers.
const H2_FORBIDDEN_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'transfer-encoding'
])

// curl exit codes mapped onto the Node error codes request.js already retries
// (CONNECT_FAILURE_CODES) or upstream-error.js#isTransportInterruption accepts.
// Every other non-zero exit is a transport-level failure too (TLS, proxy
// protocol, ...), so unmapped codes become ECONNRESET instead of an opaque one.
const CURL_EXIT_CODES = { 6: 'EAI_AGAIN', 7: 'ECONNREFUSED', 28: 'ETIMEDOUT', 56: 'ECONNRESET' }

const HEADER_BLOCK_END = Buffer.from('\r\n\r\n')
const HEADER_BLOCK_MAX_BYTES = 64 * 1024
const ERROR_BODY_MAX_BYTES = 64 * 1024
const STDERR_MAX_BYTES = 8 * 1024

let warnedAutoFallbackOnce = false
let resolvedBinaryCache = null

/**
 * Locate the curl-impersonate-chrome executable: explicit CURL_IMPERSONATE_BIN
 * path first, then a PATH scan. Success is memoized per source so the PATH is
 * not re-scanned on every completions call; failures are not memoized — a
 * binary installed (or a path fixed) later starts working on the next request.
 * @returns {string|null}
 */
const resolveImpersonateBinary = () => {
    const source = config.curlImpersonateBin && String(config.curlImpersonateBin).trim()
        || 'curl-impersonate-chrome'
    if (resolvedBinaryCache && resolvedBinaryCache.source === source) {
        return resolvedBinaryCache.path
    }
    let found = null
    try { fs.accessSync(source, fs.constants.F_OK); found = source } catch { /* configured path missing */ }
    if (!found && !path.isAbsolute(source)) {
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            if (!dir) continue
            const candidate = path.join(dir, source)
            try { fs.accessSync(candidate, fs.constants.F_OK); found = candidate; break } catch { /* keep scanning */ }
        }
    }
    resolvedBinaryCache = { source, path: found }
    return found
}

// socks5 -> socks5h: DNS must resolve on the proxy (remote), matching the
// socks5h semantics the axios path enforces; otherwise the local resolver
// leaks the target hostname and datacenter local DNS may differ from egress.
const curlProxyUrl = (proxyUrl) => {
    if (!proxyUrl) return null
    return String(proxyUrl).replace(/^socks5:\/\//i, 'socks5h://')
}

/**
 * Build the curl-impersonate argv for a completions POST. Pure — unit tests
 * assert the exact shape. Body is NOT in argv: it travels over stdin via
 * `--data-binary @-`, both for Chrome parity (no Expect: 100-continue on large
 * bodies, suppressed explicitly) and because a single argv element is capped
 * at ~128 KiB on Linux while agent contexts legitimately approach that.
 * @returns {string[]}
 */
const buildImpersonateArgv = ({ url, headers = {}, maxTimeSeconds = 600, proxyUrl = null }) => {
    const argv = [
        ...CHROME116_TLS_FLAGS,
        ...(/^https:/i.test(String(url)) ? HTTPS_VERSION_FLAGS : HTTP_VERSION_FLAGS),
        '-sS', '-i', '-N', '--max-time', String(maxTimeSeconds)
    ]
    // Empty value removes curl's internal Expect header; without it bodies
    // over ~1 KiB get Expect: 100-continue, which Chrome never sends.
    argv.push('-H', 'Expect:')
    for (const [name, value] of Object.entries(headers)) {
        if (H2_FORBIDDEN_HEADERS.has(String(name).toLowerCase())) continue
        if (value === undefined || value === null) continue
        argv.push('-H', `${name}: ${value}`)
    }
    argv.push('--data-binary', '@-')
    const proxy = curlProxyUrl(proxyUrl)
    if (proxy) argv.push('--proxy', proxy)
    argv.push(String(url))
    return argv
}

// Every string built here can end up in a log line or a thrown Error: mask
// credentials embedded in URLs (proxy URLs reach stderr on connect failures)
// and blank the request's own secret values (defense in depth — curl never
// echoes request headers without -v, which we never pass).
const redactImpersonateText = (text, secrets = []) => {
    let out = String(text ?? '')
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]+):([^@/\s]+)@/gi, '$1***@')
    for (const secret of secrets) {
        const value = String(secret ?? '')
        if (value.length >= 8) out = out.split(value).join('***')
    }
    return out.length > 300 ? out.slice(0, 300) + '…' : out
}

const secretHeaderValues = (headers) => Object.entries(headers || {})
    .filter(([name]) => ['authorization', 'cookie', 'set-cookie'].includes(String(name).toLowerCase()))
    .map(([, value]) => value)

/**
 * Parse one `curl -i` response head block ("HTTP/2 200" over h2, "HTTP/1.1
 * 200 OK" otherwise). Header names are lowercased like axios does; repeated
 * set-cookie values are joined, everything else is last-wins.
 * @returns {{status:number, statusText:string, headers:object}|null}
 */
const parseHeadBlock = (block) => {
    const lines = block.toString('utf8').split('\r\n')
    const statusMatch = /^HTTP\/[\d.]+ +(\d{3})(?: +(.*))?$/.exec(lines[0] || '')
    if (!statusMatch) return null
    const headers = {}
    for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(':')
        if (colon <= 0) continue
        const name = lines[i].slice(0, colon).trim().toLowerCase()
        const value = lines[i].slice(colon + 1).replace(/^[ \t]+/, '')
        if (!name) continue
        headers[name] = name === 'set-cookie' && headers[name] !== undefined
            ? `${headers[name]}, ${value}`
            : value
    }
    return { status: Number(statusMatch[1]), statusText: (statusMatch[2] || '').trim(), headers }
}

const transportError = (code, detail, secrets) => {
    const error = new Error(detail ? `${codeMessage(code)}: ${redactImpersonateText(detail, secrets)}` : codeMessage(code))
    error.code = code
    return error
}

const codeMessage = (code) => (
    code === 'ETIMEDOUT' ? 'curl-impersonate timed out'
        : code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'curl-impersonate closed without a response'
            : `curl-impersonate transport failed (${code})`
)

const exitCodeToNodeCode = (code, timedOut) => {
    if (timedOut) return 'ETIMEDOUT'
    if (code === 0) return 'ERR_STREAM_PREMATURE_CLOSE'
    return CURL_EXIT_CODES[code] || 'ECONNRESET'
}

/**
 * POST a JSON payload through curl-impersonate-chrome and resolve an
 * axios-shaped response: { status, statusText, headers, data } where data is a
 * Readable of the (auto-decompressed) body — the same shape postChatRequest
 * and screenHtmlChallenge consume from axios with responseType: 'stream'.
 * Non-2xx rejects with an axios-like error (code ERR_BAD_REQUEST /
 * ERR_BAD_RESPONSE, response.status/headers/data) so describeUpstreamFailure
 * classifies it exactly like the axios path, including 429 quota handling.
 *
 * @param {string} url
 * @param {object} payload - JSON body, piped to curl's stdin
 * @param {object} [options]
 * @param {object} [options.headers] - Full FE header set incl. Authorization/cookie
 * @param {number} [options.timeoutMs] - Whole-transfer budget (axios timeout parity)
 * @param {string|null} [options.proxyUrl] - Account/global proxy URL
 * @returns {Promise<{status:number, statusText:string, headers:object, data:Readable}>}
 */
const impersonatePostJson = (url, payload, { headers = {}, timeoutMs = 10 * 60 * 1000, proxyUrl = null } = {}) =>
    new Promise((resolve, reject) => {
        const binary = resolveImpersonateBinary()
        if (!binary) {
            reject(new Error('curl-impersonate binary not found (set CURL_IMPERSONATE_BIN or put curl-impersonate-chrome on PATH)'))
            return
        }
        const secrets = secretHeaderValues(headers)
        if (proxyUrl) secrets.push(proxyUrl)
        const argv = buildImpersonateArgv({ url, headers, maxTimeSeconds: Math.ceil(timeoutMs / 1000), proxyUrl })

        let child
        try {
            // Required lazily at call time so tests can stub child_process.spawn.
            child = require('node:child_process').spawn(binary, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (error) {
            reject(transportError(error.code || 'ECONNRESET', error.message, secrets))
            return
        }

        // States: HEADERS until a final head block is parsed; STREAM once a 2xx
        // body Readable is live; ERROR_BODY while a non-2xx body is being buffered.
        const HEADERS = 0
        const STREAM = 1
        const ERROR_BODY = 2
        let state = HEADERS
        let settled = false
        let timedOut = false

        let headBlock = null
        let errorBody = []
        let errorBodyBytes = 0
        let errorHead = null
        let stderrText = ''
        let stdoutEnded = false
        let stream = null
        let streamEnded = false

        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, Math.max(1000, timeoutMs) + 5000)

        const finishReject = (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
        }
        const finishResolve = (response) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(response)
        }

        // EPIPE on stdin means curl died before reading the body; the close
        // path reports the real cause, this only keeps the process from crashing.
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(payload ?? {}))

        child.stderr.on('data', (chunk) => {
            if (stderrText.length < STDERR_MAX_BYTES) stderrText += chunk.toString('utf8')
        })

        const consumeHead = (chunk) => {
            headBlock = headBlock ? Buffer.concat([headBlock, chunk]) : Buffer.from(chunk)
            if (headBlock.length > HEADER_BLOCK_MAX_BYTES) {
                finishReject(transportError('ERR_STREAM_PREMATURE_CLOSE', 'response head exceeded size limit', secrets))
                child.kill('SIGKILL')
                return
            }
            let start = 0
            for (;;) {
                const at = headBlock.indexOf(HEADER_BLOCK_END, start)
                if (at < 0) {
                    if (start > 0) headBlock = Buffer.from(headBlock.subarray(start))
                    return
                }
                const head = parseHeadBlock(headBlock.subarray(start, at))
                if (!head) {
                    finishReject(transportError('ERR_STREAM_PREMATURE_CLOSE', 'unrecognized response head', secrets))
                    child.kill('SIGKILL')
                    return
                }
                const bodyStart = at + HEADER_BLOCK_END.length
                // Interim 1xx responses: drop the block and keep scanning.
                if (head.status >= 100 && head.status < 200) {
                    start = bodyStart
                    continue
                }
                const rest = headBlock.subarray(bodyStart)
                headBlock = null
                if (head.status >= 200 && head.status < 300) {
                    stream = new Readable({ read() {} })
                    // A consumer aborting the SSE stream must not leave curl running.
                    stream.on('close', () => child.kill('SIGTERM'))
                    if (rest.length > 0) stream.push(rest)
                    state = STREAM
                    finishResolve({ status: head.status, statusText: head.statusText, headers: head.headers, data: stream })
                } else {
                    errorHead = head
                    errorBody = rest.length > 0 ? [rest] : []
                    errorBodyBytes = rest.length
                    state = ERROR_BODY
                }
                return
            }
        }

        child.stdout.on('data', (chunk) => {
            if (state === HEADERS) { consumeHead(chunk); return }
            if (state === STREAM) {
                if (!stream.destroyed && !streamEnded) stream.push(chunk)
                return
            }
            if (errorBodyBytes < ERROR_BODY_MAX_BYTES) {
                errorBody.push(chunk)
                errorBodyBytes += chunk.length
            }
        })

        child.stdout.on('end', () => {
            stdoutEnded = true
            if (state === STREAM) {
                streamEnded = true
                stream.push(null)
            }
        })

        child.on('error', (error) => {
            const code = exitCodeToNodeCode(error.code === 'ENOENT' ? 0 : 1, false)
            if (state === STREAM && !streamEnded) stream.destroy(transportError(code, error.message, secrets))
            else finishReject(transportError(code, error.message, secrets))
        })

        child.on('close', (code) => {
            clearTimeout(timer)
            const nodeCode = exitCodeToNodeCode(code, timedOut)
            if (state === STREAM) {
                if (!streamEnded) stream.destroy(transportError(nodeCode, stderrText, secrets))
                return
            }
            if (state === ERROR_BODY) {
                const body = Buffer.concat(errorBody).toString('utf8')
                const error = new Error(`Request failed with status code ${errorHead.status}`)
                error.isAxiosError = true
                error.code = errorHead.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST'
                error.response = { status: errorHead.status, statusText: errorHead.statusText, headers: errorHead.headers, data: body }
                finishReject(error)
                return
            }
            // HEADERS state: curl exited (or stdout ended) without a final head.
            finishReject(transportError(stdoutEnded ? 'ERR_STREAM_PREMATURE_CLOSE' : nodeCode, stderrText, secrets))
        })
    })

/**
 * The single completions send seam (postChatRequest). Mode comes from
 * COMPLETIONS_TRANSPORT: 'axios' keeps plain Node TLS; 'impersonate' requires
 * the binary and fails loudly when it is missing (silently degrading would
 * bring the Baxia punish back and hide the cause); 'auto' (default) uses the
 * impersonating transport when the binary is present and falls back to axios
 * with a single warning per process; 'browser' (Qwen2API-3ue.3) sends the
 * call from inside the account's resident page in the signin worker, which
 * needs the account (browser-egress.js).
 *
 * @param {string} url
 * @param {object} payload
 * @param {object} requestConfig - axios-style config (headers, timeout, agents)
 * @param {object} [options]
 * @param {string|null} [options.proxyUrl] - Proxy for the impersonate path; the
 *   axios path takes it from requestConfig agents instead.
 * @param {Object} [options.account] - For 'browser': whose page the call leaves from
 * @returns {Promise<object>} axios-shaped response with data as a Readable
 */
const postCompletions = async (url, payload, requestConfig, { proxyUrl = null, account = null } = {}) => {
    const mode = config.completionsTransport
    if (mode === 'browser') {
        // Taken here, not at the top: the egress carries the session store in,
        // which the other transports have no use for.
        const browserEgress = require('./browser-egress.js')
        return browserEgress.postCompletions({
            url, body: JSON.stringify(payload ?? {}), account, timeoutMs: requestConfig?.timeout
        })
    }
    if (mode === 'axios') return axios.post(url, payload, requestConfig)
    const binary = resolveImpersonateBinary()
    if (!binary) {
        if (mode === 'impersonate') {
            throw new Error(
                'COMPLETIONS_TRANSPORT=impersonate but the curl-impersonate binary was not found ' +
                '(set CURL_IMPERSONATE_BIN or install curl-impersonate-chrome on PATH)'
            )
        }
        if (!warnedAutoFallbackOnce) {
            warnedAutoFallbackOnce = true
            logger.warn(
                'COMPLETIONS_TRANSPORT=auto: curl-impersonate binary not found, completions use plain Node TLS (axios); Baxia may punish completions',
                'REQUEST'
            )
        }
        return axios.post(url, payload, requestConfig)
    }
    return impersonatePostJson(url, payload, {
        headers: requestConfig?.headers || {},
        timeoutMs: requestConfig?.timeout || 10 * 60 * 1000,
        proxyUrl
    })
}

const resetImpersonateTransportForTests = () => {
    warnedAutoFallbackOnce = false
    resolvedBinaryCache = null
}

module.exports = {
    postCompletions,
    impersonatePostJson,
    buildImpersonateArgv,
    resolveImpersonateBinary,
    redactImpersonateText,
    resetImpersonateTransportForTests,
    CHROME116_CIPHERS
}
