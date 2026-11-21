const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { text } = require('node:stream/consumers')
const axios = require('axios')

const childProcess = require('node:child_process')
const config = require('../src/config')
const { logger } = require('../src/utils/logger')
const transport = require('../src/utils/impersonate-transport')
const { describeUpstreamFailure, isTransportInterruption } = require('../src/utils/upstream-error')

const TOKEN = 'jwt-secret-token-value-0123456789'
const URL = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc123'
const FE_HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    'sec-ch-ua-platform': '"Windows"',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'accept': 'application/json',
    'source': 'web',
    'Version': '0.3.49',
    'timezone': 'Sat Nov 21 2026 19:55:52 GMT+0400',
    'referer': 'https://chat.qwen.ai/c/abc123',
    'Authorization': `Bearer ${TOKEN}`,
    'cookie': `token=${TOKEN}; ssxmod_itna=fingerprint`,
    'connection': 'keep-alive'
}
const PAYLOAD = { model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'Reply with OK' }] }

let binDir = null
let binPath = null

// A fake child good enough for the transport: pipeable stdio, kill spy, and
// manual event emission for exit paths.
function fakeChild() {
    const child = new (require('node:events').EventEmitter)()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.killCount = 0
    child.kill = () => { child.killCount += 1; return true }
    return child
}

function stubSpawn(t, onSpawn) {
    const realSpawn = childProcess.spawn
    const calls = []
    childProcess.spawn = (bin, argv, opts) => {
        const child = fakeChild()
        const stdinChunks = []
        child.stdin.on('data', chunk => stdinChunks.push(chunk))
        const call = { bin, argv, opts, child, stdinChunks }
        calls.push(call)
        if (onSpawn) onSpawn(call)
        return child
    }
    t.after(() => { childProcess.spawn = realSpawn })
    return calls
}

function stubAxiosPost(t) {
    const calls = []
    const realPost = axios.post
    axios.post = async (...args) => {
        calls.push(args)
        return { status: 200, statusText: 'OK', headers: {}, data: PassThrough.from(['axios']) }
    }
    t.after(() => { axios.post = realPost })
    return calls
}

function respond(call, head, body) {
    call.child.stdout.write(head)
    if (body) call.child.stdout.write(body)
}

before(async () => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen2-curl-impersonate-test-'))
    binPath = path.join(binDir, 'curl-impersonate-chrome')
    fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n')
})
after(async () => { fs.rmSync(binDir, { recursive: true, force: true }) })

beforeEach(() => {
    transport.resetImpersonateTransportForTests()
    config.completionsTransport = 'auto'
    config.curlImpersonateBin = null
})

test('impersonate argv carries the chrome116 TLS profile, FE headers over argv and the body over stdin', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.postCompletions(URL, PAYLOAD, { headers: FE_HEADERS, timeout: 123000 })
    const call = calls[0]
    assert.equal(call.bin, binPath)
    assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe'])
    const argv = call.argv
    for (const flag of ['--http2', '--http2-no-server-push', '--compressed', '--tlsv1.2', '--alps',
        '--tls-permute-extensions', '-sS', '-i', '-N']) assert.ok(argv.includes(flag), flag)
    assert.ok(argv.includes('--ciphers'))
    assert.ok(argv[argv.indexOf('--ciphers') + 1].startsWith('TLS_AES_128_GCM_SHA256'))
    assert.deepEqual(argv.slice(argv.indexOf('--max-time'), argv.indexOf('--max-time') + 2), ['--max-time', '123'])
    assert.deepEqual(argv.slice(argv.indexOf('--data-binary'), argv.indexOf('--data-binary') + 2), ['--data-binary', '@-'])
    assert.deepEqual(argv.slice(argv.indexOf('Expect:') - 1, argv.indexOf('Expect:') + 1), ['-H', 'Expect:'])
    for (const pair of [
        `Authorization: Bearer ${TOKEN}`,
        `cookie: token=${TOKEN}; ssxmod_itna=fingerprint`,
        'Version: 0.3.49',
        'timezone: Sat Nov 21 2026 19:55:52 GMT+0400',
        'source: web',
        'content-type: application/json'
    ]) assert.deepEqual(argv.slice(argv.indexOf(pair) - 1, argv.indexOf(pair) + 1), ['-H', pair])
    // Hop-by-hop headers must not ride an HTTP/2 request.
    for (let i = 0; i + 1 < argv.length; i++) {
        if (argv[i] !== '-H') continue
        assert.doesNotMatch(argv[i + 1], /^(connection|keep-alive|upgrade|transfer-encoding):/i)
    }
    assert.equal(argv[argv.length - 1], URL)
    assert.equal(Buffer.concat(call.stdinChunks).toString('utf8'), JSON.stringify(PAYLOAD))
    // Drive to completion so timers and streams settle; a real curl flushes
    // stdio before 'close', so the test must let each write get consumed.
    respond(call, 'HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n')
    const response = await promise
    assert.equal(response.status, 200)
    const streamed = text(response.data)
    call.child.stdout.end()
    await streamed
    call.child.emit('close', 0)
})

test('plain-http URLs never attempt an h2c upgrade: argv pins HTTP/1.1 (73u)', () => {
    // --http2 on a plain http URL makes curl open with Connection: Upgrade /
    // Upgrade: h2c; Bun's http server (the CI smoke stub) never answers that
    // and the request hangs to --max-time. Only https URLs keep --http2.
    const httpsArgv = transport.buildImpersonateArgv({ url: URL, headers: FE_HEADERS })
    assert.ok(httpsArgv.includes('--http2'))
    assert.ok(httpsArgv.includes('--http2-no-server-push'))
    assert.ok(!httpsArgv.includes('--http1.1'))
    const httpArgv = transport.buildImpersonateArgv({
        url: 'http://127.0.0.1:8099/api/v2/chat/completions?chat_id=x',
        headers: FE_HEADERS
    })
    assert.ok(httpArgv.includes('--http1.1'))
    assert.ok(!httpArgv.includes('--http2'))
    assert.ok(!httpArgv.includes('--http2-no-server-push'))
    // The TLS profile itself is scheme-independent and stays in place.
    assert.ok(httpArgv.includes('--ciphers'))
    assert.ok(httpArgv.includes('--tls-permute-extensions'))
})

test('SSE stdout chunks are piped through the response Readable verbatim', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    respond(call, 'HTTP/2 200 \r\ncontent-type: text/event-stream; charset=utf-8\r\nx-request-id: r1\r\n\r\n')
    const sse = 'data: {"choices":[{"delta":{"phase":"answer","content":"pon"}}]}\n\n' +
        'data: {"choices":[{"delta":{"phase":"answer","content":"g"}}]}\n\ndata: [DONE]\n\n'
    for (const piece of sse.match(/[\s\S]{1,17}/g)) call.child.stdout.write(piece)
    const response = await promise
    assert.equal(response.status, 200)
    assert.equal(response.statusText, '')
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(response.headers['x-request-id'], 'r1')
    const streamed = text(response.data)
    call.child.stdout.end()
    assert.equal(await streamed, sse)
    call.child.emit('close', 0)
})

test('an HTML challenge page flows through unchanged for the existing WAF classifier', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    respond(call, 'HTTP/2 200 \r\ncontent-type: text/html\r\n\r\n', '<!doctype html><meta name="aliyun_waf_aa">captcha</html>')
    const response = await promise
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /text\/html/)
    const streamed = text(response.data)
    call.child.stdout.end()
    assert.match(await streamed, /aliyun_waf_aa/)
    call.child.emit('close', 0)
})

test('non-2xx rejects with an axios-shaped error the existing classifier reads (429 quota)', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    respond(call, 'HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\nretry-after: 3600\r\n\r\n',
        '{"error":{"code":"RateLimited"}}')
    call.child.stdout.end()
    call.child.emit('close', 0)
    const error = await promise.then(() => { throw new Error('should reject') }, e => e)
    assert.equal(error.response.status, 429)
    assert.equal(error.response.statusText, 'Too Many Requests')
    assert.equal(error.response.headers['retry-after'], '3600')
    assert.match(error.response.data, /RateLimited/)
    assert.equal(error.code, 'ERR_BAD_REQUEST')
    const failure = describeUpstreamFailure(error, 502, 503)
    assert.equal(failure.rateLimited, true)
    assert.equal(failure.retryAfter, 3600)
    assert.doesNotMatch(error.message, new RegExp(TOKEN))
})

test('pre-header curl failures map to retryable transport codes with secrets redacted', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, {
        headers: FE_HEADERS, timeoutMs: 5000, proxyUrl: 'socks5://user:secretpw@proxy-internal:1080'
    })
    const call = calls[0]
    assert.deepEqual(call.argv.slice(call.argv.indexOf('--proxy'), call.argv.indexOf('--proxy') + 2),
        ['--proxy', 'socks5h://user:secretpw@proxy-internal:1080'])
    call.child.stderr.write('curl: (56) Recv failure: Connection reset by peer https://user:secretpw@proxy-internal:1080/')
    call.child.stderr.end()
    call.child.emit('close', 56)
    const error = await promise.then(() => { throw new Error('should reject') }, e => e)
    assert.equal(error.code, 'ECONNRESET')
    assert.equal(isTransportInterruption(error), true)
    assert.doesNotMatch(error.message, /secretpw/)
    assert.doesNotMatch(error.message, new RegExp(TOKEN))
    assert.match(error.message, /\*\*\*@/)
})

test('curl timeout (exit 28) maps to ETIMEDOUT transport interruption', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    call.child.stderr.write('curl: (28) Operation timed out')
    call.child.emit('close', 28)
    const error = await promise.then(() => { throw new Error('should reject') }, e => e)
    assert.equal(error.code, 'ETIMEDOUT')
    assert.equal(isTransportInterruption(error), true)
})

test('a spawn failure surfaces sanitized, never the header secrets', async t => {
    config.curlImpersonateBin = binPath
    const realSpawn = childProcess.spawn
    childProcess.spawn = () => {
        throw Object.assign(new Error('spawn /usr/local/bin/curl-impersonate-chrome ENOENT'), { code: 'ENOENT' })
    }
    t.after(() => { childProcess.spawn = realSpawn })
    const error = await transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
        .then(() => { throw new Error('should reject') }, e => e)
    assert.match(error.message, /ENOENT/)
    assert.doesNotMatch(error.message, new RegExp(TOKEN))
})

test('mid-stream curl death destroys the SSE stream with a transport interruption code', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    respond(call, 'HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n', 'data: {"choices":[]}\n\n')
    const response = await promise
    call.child.stderr.write('curl: (56) Recv failure')
    call.child.emit('close', 56)
    const streamError = await text(response.data).then(() => null, e => e)
    assert.equal(streamError.code, 'ECONNRESET')
    assert.equal(isTransportInterruption(streamError), true)
})

test('destroying the response stream kills the curl child (client abort)', async t => {
    config.curlImpersonateBin = binPath
    const calls = stubSpawn(t)
    const promise = transport.impersonatePostJson(URL, PAYLOAD, { headers: FE_HEADERS, timeoutMs: 5000 })
    const call = calls[0]
    respond(call, 'HTTP/2 200 \r\ncontent-type: text/event-stream\r\n\r\n')
    const response = await promise
    response.data.destroy()
    // 'close' on the Readable fires asynchronously after destroy().
    await new Promise(resolve => response.data.once('close', resolve))
    assert.equal(call.child.killCount, 1)
    call.child.emit('close', 0)
})

test('auto mode falls back to axios exactly once per process when the binary is missing', async t => {
    config.curlImpersonateBin = path.join(binDir, 'definitely-missing')
    const axiosCalls = stubAxiosPost(t)
    const calls = stubSpawn(t)
    const warns = []
    const realWarn = logger.warn
    logger.warn = (...args) => { warns.push(args); return realWarn.apply(logger, args) }
    t.after(() => { logger.warn = realWarn })
    const requestConfig = { headers: FE_HEADERS, timeout: 600000 }
    await transport.postCompletions(URL, PAYLOAD, requestConfig)
    await transport.postCompletions(URL, PAYLOAD, requestConfig)
    assert.equal(axiosCalls.length, 2)
    assert.equal(axiosCalls[0][0], URL)
    assert.equal(axiosCalls[0][1], PAYLOAD)
    assert.equal(axiosCalls[0][2], requestConfig)
    assert.equal(calls.length, 0)
    assert.equal(warns.filter(args => String(args[0]).includes('COMPLETIONS_TRANSPORT=auto')).length, 1)
    assert.doesNotMatch(warns.join(' '), new RegExp(TOKEN))
})

test('axios mode never spawns even when the binary is present', async t => {
    config.completionsTransport = 'axios'
    config.curlImpersonateBin = binPath
    const axiosCalls = stubAxiosPost(t)
    const calls = stubSpawn(t)
    await transport.postCompletions(URL, PAYLOAD, { headers: FE_HEADERS, timeout: 600000 })
    assert.equal(axiosCalls.length, 1)
    assert.equal(calls.length, 0)
})

test('impersonate mode fails loudly instead of silently degrading when the binary is missing', async t => {
    config.completionsTransport = 'impersonate'
    config.curlImpersonateBin = path.join(binDir, 'definitely-missing')
    const axiosCalls = stubAxiosPost(t)
    const calls = stubSpawn(t)
    const error = await transport.postCompletions(URL, PAYLOAD, { headers: FE_HEADERS, timeout: 600000 })
        .then(() => { throw new Error('should reject') }, e => e)
    assert.match(error.message, /COMPLETIONS_TRANSPORT=impersonate/)
    assert.equal(axiosCalls.length, 0)
    assert.equal(calls.length, 0)
})

test('http proxies pass through unchanged while socks5 is upgraded to socks5h (remote DNS)', () => {
    const argv = transport.buildImpersonateArgv({ url: URL, headers: {}, maxTimeSeconds: 1, proxyUrl: 'http://proxy:8080' })
    assert.deepEqual(argv.slice(argv.indexOf('--proxy'), argv.indexOf('--proxy') + 2), ['--proxy', 'http://proxy:8080'])
})

test('COMPLETIONS_TRANSPORT parsing accepts the three modes and rejects anything else', () => {
    assert.equal(config.parseCompletionsTransport(), 'auto')
    assert.equal(config.parseCompletionsTransport(''), 'auto')
    assert.equal(config.parseCompletionsTransport('auto'), 'auto')
    assert.equal(config.parseCompletionsTransport(' IMPERSONATE '), 'impersonate')
    assert.equal(config.parseCompletionsTransport('axios'), 'axios')
    assert.throws(() => config.parseCompletionsTransport('curl'), /COMPLETIONS_TRANSPORT/)
})
