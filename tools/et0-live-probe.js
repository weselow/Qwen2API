/**
 * et0 live integration probe: full v2 session cycle against real Qwen.
 * Each network step runs exactly once; no retries, no redirects, no proxy.
 * Credentials come from QWEN_TEST_EMAIL / QWEN_TEST_PASSWORD only and never
 * reach the report: it records statuses, content types and cookie NAMES.
 *
 * Flow: GET chat.qwen.ai/auth (pre-login cookies) ->
 *       POST auth.qwen.ai/api/v2/auths/signin ->
 *       GET  auth.qwen.ai/api/v2/auths/refresh ->
 *       POST chat.qwen.ai/api/v2/chats/new ->
 *       POST chat.qwen.ai/api/v2/chat/completions (SSE, expect model text).
 */
process.env.ENABLE_FILE_LOG = 'false'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const axios = require('axios')
const { CookieJar } = require('tough-cookie')

const { buildSigninHeaders, buildRequestHeaders, LEGACY_HEADERS } = require('../src/utils/header-profile')
const { detectWafChallenge } = require('../src/utils/upstream-error')
const { sha256Encrypt } = require('../src/utils/tools')

const FORM_ORIGIN = process.env.ET0_FORM_ORIGIN || 'https://chat.qwen.ai'
const AUTH_ORIGIN = process.env.ET0_AUTH_ORIGIN || 'https://auth.qwen.ai'
const MODEL = process.env.ET0_MODEL || 'qwen3-max'
const EMAIL = process.env.QWEN_TEST_EMAIL
const PASSWORD = process.env.QWEN_TEST_PASSWORD

const formUrl = `${FORM_ORIGIN}/auth`
const signinUrl = `${AUTH_ORIGIN}/api/v2/auths/signin`
const refreshUrl = `${AUTH_ORIGIN}/api/v2/auths/refresh`
const chatNewUrl = `${FORM_ORIGIN}/api/v2/chats/new`

const report = { startedAt: new Date().toISOString(), formOrigin: FORM_ORIGIN, authOrigin: AUTH_ORIGIN,
    model: MODEL, account: EMAIL ? EMAIL.replace(/^(.).*@/, '$1***@') : null, steps: [] }

function record(step, extra) {
    const entry = { step, ...extra }
    report.steps.push(entry)
    console.log(JSON.stringify(entry))
    return entry
}

function bodySummary(data) {
    if (data == null) return null
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    return { chars: text.length, head: text.slice(0, 300).replace(/\s+/g, ' ') }
}

function cookieNames(jar) {
    return jar.toJSON().cookies.map(c => `${c.key} (domain=${c.domain} path=${c.path}${c.hostOnly ? ' host-only' : ''})`)
}

function readCookies(jar, response, url) {
    for (const line of [].concat(response.headers['set-cookie'] || [])) {
        jar.setCookieSync(line, url, { ignoreError: true })
    }
}

async function once(label, config) {
    const began = Date.now()
    try {
        const response = await axios.request({ timeout: 30000, maxRedirects: 0,
            validateStatus: () => true, ...config })
        response.elapsedMs = Date.now() - began
        return response
    } catch (error) {
        error.elapsedMs = Date.now() - began
        error.rethrown = label
        throw error
    }
}

function classify(response) {
    const ct = String(response.headers['content-type'] || '')
    const html = /^text\/html\b/i.test(ct)
    const json = /^application\/json\b/i.test(ct)
    return { status: response.status, contentType: ct || null, html, json,
        waf: html ? Boolean(detectWafChallenge(response.data)) || /errors\.aliyun\.com|blocked-message|405\.png/i.test(response.data) : false,
        apiError: json && response.data ? (response.data.error || response.data.code || null) : null }
}

async function main() {
    if (!EMAIL || !PASSWORD) throw new Error('QWEN_TEST_EMAIL and QWEN_TEST_PASSWORD are required')

    // 1. Pre-login form: collect cookies exactly where the FE hosts the form.
    const jar = new CookieJar()
    const form = await once('form', { method: 'get', url: formUrl, headers: {
        ...LEGACY_HEADERS, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1' } })
    readCookies(jar, form, formUrl)
    record('form', { ...classify(form), elapsedMs: form.elapsedMs,
        receivedCookies: cookieNames(jar), body: bodySummary(form.data) })
    if (form.status !== 200) throw new Error(`form status ${form.status}`)

    // 2. Signin on the dedicated auth host with the form cookies that apply there.
    const signinHeaders = buildSigninHeaders(undefined, { chatBaseUrl: FORM_ORIGIN })
    signinHeaders['sec-fetch-site'] = 'cross-site' // auth host differs from the form host
    const signinCookie = jar.getCookieStringSync(signinUrl)
    signinHeaders.cookie = signinCookie
    const signin = await once('signin', { method: 'post', url: signinUrl, headers: signinHeaders,
        data: { email: EMAIL, password: sha256Encrypt(PASSWORD) } })
    const signinInfo = classify(signin)
    record('signin', { ...signinInfo, elapsedMs: signin.elapsedMs, sentCookieCount: signinCookie ? signinCookie.split(';').length : 0,
        tokenReceived: Boolean(signinInfo.json && signin.data && signin.data.token), body: bodySummary(signin.data) })
    if (!signinInfo.json || signin.status !== 200 || !signin.data || !signin.data.token) {
        throw new Error(`signin did not return a token (status ${signin.status}, ${signinInfo.contentType})`)
    }
    const token = signin.data.token
    readCookies(jar, signin, signinUrl)
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    record('signin-session', { tokenExp: new Date(decoded.exp * 1000).toISOString(),
        tokenSub: String(decoded.sub || '').replace(/^(.).*@/, '$1***@'), cookies: cookieNames(jar) })

    // 3. Refresh rotates the session; keep the previous jar unless it succeeds cleanly.
    const refreshHeaders = buildSigninHeaders(undefined, { chatBaseUrl: FORM_ORIGIN })
    delete refreshHeaders['content-type']
    refreshHeaders['sec-fetch-site'] = 'cross-site'
    refreshHeaders.cookie = jar.getCookieStringSync(refreshUrl)
    const refresh = await once('refresh', { method: 'get', url: refreshUrl, headers: refreshHeaders })
    const refreshInfo = classify(refresh)
    record('refresh', { ...refreshInfo, elapsedMs: refresh.elapsedMs,
        tokenReceived: Boolean(refreshInfo.json && refresh.data && refresh.data.token), body: bodySummary(refresh.data) })
    if (refresh.status === 200 && refreshInfo.json && refresh.data && refresh.data.token) {
        const before = cookieNames(jar)
        readCookies(jar, refresh, refreshUrl)
        record('refresh-session', { rotated: true, before, after: cookieNames(jar) })
    }

    // 4. Chat creation with session cookies merged ahead of the legacy token pair.
    const chatHeaders = buildRequestHeaders(undefined, { chatBaseUrl: FORM_ORIGIN, token,
        accept: 'application/json, text/plain, */*', refererPath: '/c/new-chat',
        extra: { 'x-request-id': crypto.randomUUID() } })
    const chatUrl0 = new URL(chatNewUrl)
    const sessionCookies = jar.getCookiesSync(chatUrl0.href)
    const scoped = new Set(sessionCookies.map(c => c.key))
    const legacyPairs = (chatHeaders.cookie || '').split(';').filter(Boolean)
        .filter(pair => !scoped.has(pair.split('=', 1)[0]))
    chatHeaders.cookie = [...sessionCookies.map(c => c.cookieString()), ...legacyPairs].join('; ')
    const chatNew = await once('chats/new', { method: 'post', url: chatNewUrl, headers: chatHeaders,
        data: { chatId: '', models: [MODEL], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' } })
    const chatInfo = classify(chatNew)
    const chatId = chatInfo.json && chatNew.data && chatNew.data.data && chatNew.data.data.id
    record('chats/new', { ...chatInfo, elapsedMs: chatNew.elapsedMs,
        chatId: chatId ? String(chatId).slice(0, 8) + '…' : null, body: bodySummary(chatNew.data) })
    if (!chatId) throw new Error(`chat creation did not return an id (status ${chatNew.status})`)

    // 5. Completions: stream, cap the read, extract visible model text.
    const completionsUrl = `${FORM_ORIGIN}/api/v2/chat/completions?chat_id=${chatId}`
    const sseHeaders = buildRequestHeaders(undefined, { chatBaseUrl: FORM_ORIGIN, token,
        accept: 'text/event-stream', refererPath: `/c/${chatId}`,
        extra: { 'x-request-id': crypto.randomUUID(), 'x-accel-buffering': 'no' } })
    const sseSession = jar.getCookiesSync(completionsUrl)
    const sseScoped = new Set(sseSession.map(c => c.key))
    const sseLegacy = (sseHeaders.cookie || '').split(';').filter(Boolean)
        .filter(pair => !sseScoped.has(pair.split('=', 1)[0]))
    sseHeaders.cookie = [...sseSession.map(c => c.cookieString()), ...sseLegacy].join('; ')
    const sse = await axios.post(completionsUrl, { model: MODEL, stream: true, chat_id: chatId,
        chatId, parent_id: null, parentId: null,
        messages: [{ role: 'user', content: 'Reply with exactly one word: pong', parent_id: null, parentId: null }] },
    { headers: sseHeaders, responseType: 'stream', timeout: 120000, maxRedirects: 0, validateStatus: () => true })

    const sseInfo = { step: 'completions', status: sse.status, contentType: sse.headers['content-type'] || null,
        elapsedMs: 0, events: 0, text: '', finishReason: null }
    if (sse.status !== 200 || !/text\/event-stream/i.test(String(sse.headers['content-type'] || ''))) {
        const chunks = []
        sse.data.on('data', c => { if (chunks.length < 32) chunks.push(c) })
        await new Promise(resolve => sse.data.on('end', resolve))
        sseInfo.body = bodySummary(Buffer.concat(chunks).toString('utf8'))
        record('completions', sseInfo)
        throw new Error(`completions status ${sse.status}, ${sseInfo.contentType}`)
    }
    const began = Date.now()
    await new Promise((resolve, reject) => {
        let buffer = ''
        const finish = error => { clearTimeout(guard); error ? reject(error) : resolve() }
        const guard = setTimeout(() => finish(new Error('SSE read budget exceeded')), 90000)
        sse.data.on('data', chunk => {
            buffer += chunk.toString('utf8')
            if (buffer.length > 262144) return finish()
            for (const line of buffer.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (!payload || payload === '[DONE]') continue
                try {
                    const event = JSON.parse(payload)
                    sseInfo.events++
                    if (event.choices?.[0]?.delta?.content) sseInfo.text += event.choices[0].delta.content
                    if (event.choices?.[0]?.finish_reason) sseInfo.finishReason = event.choices[0].finish_reason
                } catch { /* partial frame */ }
            }
            buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
            if (sseInfo.finishReason || sseInfo.text.length > 400) finish()
        })
        sse.data.on('end', () => finish())
        sse.data.on('error', finish)
    })
    sseInfo.elapsedMs = Date.now() - began
    sseInfo.text = sseInfo.text.slice(0, 200)
    record('completions', sseInfo)
    report.modelAnswered = Boolean(sseInfo.text.trim())
}

main().then(() => {
    report.finishedAt = new Date().toISOString()
    report.outcome = report.modelAnswered ? 'full-cycle-ok' : 'incomplete'
}).catch(error => {
    report.finishedAt = new Date().toISOString()
    report.outcome = 'failed'
    report.failure = { step: error.rethrown || null, message: String(error.message || error),
        code: error.code || null }
}).finally(() => {
    const dir = path.join(__dirname, '..', '.tmp')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `et0-live-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    console.log(`report: ${file}`)
    console.log(`outcome: ${report.outcome}`)
    process.exit(report.outcome === 'full-cycle-ok' ? 0 : 1)
})
