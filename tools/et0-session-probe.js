/**
 * et0 session handoff probe: use a browser-acquired session (token + cookie
 * string from .tmp/et0-session.json, written by the browser capture step) in
 * the adapter's own request path. Steps, each once:
 *   1. GET chat.qwen.ai/ so the adapter jar receives its own WAF cookies
 *   2. POST /api/v2/chats/new  with app headers + merged cookies
 *   3. POST /api/v2/chat/completions (SSE) — expect model text
 * Secrets stay in .tmp (gitignored); the report holds names/statuses only.
 */
process.env.ENABLE_FILE_LOG = 'false'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const axios = require('axios')
const { CookieJar } = require('tough-cookie')

const { buildRequestHeaders, LEGACY_HEADERS } = require('../src/utils/header-profile')
const { detectWafChallenge } = require('../src/utils/upstream-error')

const FORM_ORIGIN = 'https://chat.qwen.ai'
const MODEL = process.env.ET0_MODEL || 'qwen3-max'
const session = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.tmp', 'et0-session.json'), 'utf8'))

const report = { startedAt: new Date().toISOString(), steps: [] }
const record = entry => { report.steps.push(entry); console.log(JSON.stringify(entry)); return entry }
const bodySummary = data => data == null ? null : { chars: String(data).length,
    head: String(data).slice(0, 300).replace(/\s+/g, ' ') }
const classify = r => ({ status: r.status, contentType: r.headers['content-type'] || null,
    waf: /text\/html/i.test(String(r.headers['content-type'] || '')) &&
        (Boolean(detectWafChallenge(r.data)) || /aliyun_waf_aa|errors\.aliyun\.com/.test(String(r.data))),
    apiError: r.data && typeof r.data === 'object' ? (r.data?.data?.code || r.data?.error || null) : null })

function readCookies(jar, response, url) {
    for (const line of [].concat(response.headers['set-cookie'] || [])) {
        jar.setCookieSync(line, url, { ignoreError: true })
    }
}

function mergedCookie(jar, url, browserCookie) {
    const jarCookies = jar.getCookiesSync(url)
    const jarNames = new Set(jarCookies.map(c => c.key))
    const browserPairs = browserCookie.split(/;\s*/).filter(Boolean)
        .filter(pair => !jarNames.has(pair.split('=', 1)[0]))
    return [...jarCookies.map(c => c.cookieString()), ...browserPairs].join('; ')
}

async function once(config) {
    const began = Date.now()
    const response = await axios.request({ timeout: 30000, maxRedirects: 0,
        validateStatus: () => true, ...config })
    response.elapsedMs = Date.now() - began
    return response
}

async function main() {
    // 1. Adapter's own WAF cookie acquisition.
    const jar = new CookieJar()
    const home = await once({ method: 'get', url: FORM_ORIGIN + '/', headers: {
        ...LEGACY_HEADERS, accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1' } })
    readCookies(jar, home, FORM_ORIGIN + '/')
    record({ step: 'home', ...classify(home), elapsedMs: home.elapsedMs,
        jarCookies: jar.toJSON().cookies.map(c => c.key) })
    if (home.status !== 200) throw new Error('home status ' + home.status)

    // 2. Chat creation exactly as the adapter builds it.
    const chatNewUrl = FORM_ORIGIN + '/api/v2/chats/new'
    const headers = buildRequestHeaders(undefined, { chatBaseUrl: FORM_ORIGIN, token: session.token,
        accept: 'application/json, text/plain, */*', refererPath: '/c/new-chat',
        extra: { 'x-request-id': crypto.randomUUID() } })
    headers.cookie = mergedCookie(jar, chatNewUrl, session.cookie)
    const chat = await once({ method: 'post', url: chatNewUrl, headers,
        data: { chatId: '', models: [MODEL], project_id: '', timestamp: Date.now(),
            chat_type: 't2t', chat_mode: 'normal' } })
    const chatId = chat.data?.data?.id
    record({ step: 'chats/new', ...classify(chat), elapsedMs: chat.elapsedMs,
        chatId: chatId ? String(chatId).slice(0, 8) + '…' : null, body: bodySummary(chat.data) })
    if (!chatId) throw new Error('no chat id')

    // 3. Completions SSE.
    const completionsUrl = `${FORM_ORIGIN}/api/v2/chat/completions?chat_id=${chatId}`
    const sseHeaders = buildRequestHeaders(undefined, { chatBaseUrl: FORM_ORIGIN, token: session.token,
        accept: 'text/event-stream', refererPath: `/c/${chatId}`,
        extra: { 'x-request-id': crypto.randomUUID(), 'x-accel-buffering': 'no' } })
    sseHeaders.cookie = mergedCookie(jar, completionsUrl, session.cookie)
    const sse = await axios.post(completionsUrl, { model: MODEL, stream: true, chat_id: chatId,
        chatId, parent_id: null, parentId: null,
        messages: [{ role: 'user', content: 'Reply with exactly one word: pong', parent_id: null, parentId: null }] },
    { headers: sseHeaders, responseType: 'stream', timeout: 120000, maxRedirects: 0, validateStatus: () => true })

    if (sse.status !== 200 || !/text\/event-stream/i.test(String(sse.headers['content-type'] || ''))) {
        const chunks = []
        sse.data.on('data', c => { if (chunks.length < 32) chunks.push(c) })
        await new Promise(resolve => sse.data.on('end', resolve))
        record({ step: 'completions', status: sse.status, contentType: sse.headers['content-type'],
            body: bodySummary(Buffer.concat(chunks).toString('utf8')) })
        throw new Error('completions refused')
    }
    const info = { step: 'completions', status: sse.status, events: 0, text: '', finishReason: null }
    await new Promise((resolve, reject) => {
        let buffer = ''
        const finish = err => { clearTimeout(guard); err ? reject(err) : resolve() }
        const guard = setTimeout(() => finish(new Error('SSE budget')), 90000)
        sse.data.on('data', chunk => {
            buffer += chunk.toString('utf8')
            if (buffer.length > 262144) return finish()
            for (const line of buffer.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (!payload || payload === '[DONE]') continue
                try {
                    const event = JSON.parse(payload)
                    info.events++
                    if (event.choices?.[0]?.delta?.content) info.text += event.choices[0].delta.content
                    if (event.choices?.[0]?.finish_reason) info.finishReason = event.choices[0].finish_reason
                } catch { /* partial frame */ }
            }
            buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
            if (info.finishReason || info.text.length > 400) finish()
        })
        sse.data.on('end', () => finish())
        sse.data.on('error', finish)
    })
    info.text = info.text.slice(0, 200)
    record(info)
    report.modelAnswered = Boolean(info.text.trim())
}

main().then(() => { report.outcome = report.modelAnswered ? 'session-handoff-ok' : 'incomplete' })
.catch(error => { report.outcome = 'failed'; report.failure = { message: String(error.message || error) } })
.finally(() => {
    const file = path.join(__dirname, '..', '.tmp', `et0-session-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    console.log('report:', file)
    console.log('outcome:', report.outcome)
    process.exit(report.outcome === 'session-handoff-ok' ? 0 : 1)
})
