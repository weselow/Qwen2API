const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

// Two roads the review of Qwen2API-u50 saw unwatched: the periodic token
// refresh (TokenManager.batchRefreshTokens) and the Anthropic controller.
// Both call the same functions the guard of tests/account-removed-guard.test.js
// stands on — the egress, the worker client, the session's recovery —; these
// tests drive the two roads themselves, with an account the app has removed.
// The header is that file's; the egress is on, so that the roads take it.
process.env.API_KEY = 'account-removed-paths-test'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.CHAT_CREATION_TRANSPORT = 'browser'
process.env.COMPLETIONS_TRANSPORT = 'browser'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''
// The recovery's waits are read from the environment: a value set outside would move them.
delete process.env.V2_SESSION_RELOGIN_MIN_INTERVAL_MS
delete process.env.V2_SESSION_RECOVERY_MIN_INTERVAL_MS

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const config = require('../src/config')
const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const sessionPersistence = require('../src/utils/v2-session-persistence')
const registry = require('../src/utils/account-registry')
const uploadModule = require('../src/utils/upload.js')
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')
const { logger } = require('../src/utils/logger')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const HOUR = 3600
const exp = () => Math.floor(Date.now() / 1000) + HOUR
const TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: exp() })).toString('base64url')}.signature`

// `pending`, or a failure after `ms`: nothing a test waits for may keep it for ever.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
    Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

async function until(condition, timeoutMs = 5000, what = 'condition') {
    if (typeof timeoutMs !== 'number') throw new TypeError(`until(condition, timeoutMs, what): the second argument is the timeout in ms, got ${typeof timeoutMs}`)
    const deadline = Date.now() + timeoutMs
    while (!(await Promise.resolve().then(condition).catch(() => false))) {
        if (Date.now() > deadline) throw new Error(`${what} not met in ${timeoutMs} ms`)
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

// What the app says while a test runs.
function capture(t) {
    const lines = { warn: [], error: [] }
    const saved = { warn: logger.warn, error: logger.error }
    logger.warn = message => lines.warn.push(String(message))
    logger.error = message => lines.error.push(String(message))
    t.after(() => Object.assign(logger, saved))
    return lines
}

const jsonTo = (res, status, payload) => {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
}
const session = () => ({ token: TOKEN, expiresAt: exp(), cookies: [] })
const NO_PROFILE = { code: 'no_profile', message: 'No persisted profile for this account.' }

/** The worker as far as these tests are concerned: it answers every route the app knows, and writes down each request. */
async function standIn(t) {
    const requests = []
    const held = { renew: [], egress: [], stream: [], session: [] }
    const mode = { holdRenew: false, holdEgress: false, holdStream: false, holdSession: false }
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null
            requests.push(req.url)
            if (req.url === '/renew') return mode.holdRenew ? held.renew.push(res) : jsonTo(res, 200, session())
            if (req.url === '/session') {
                if (mode.holdSession) return held.session.push(res)
                return jsonTo(res, 200, session())
            }
            if (req.url === '/forget') return jsonTo(res, 200, { ok: true, session: true, page: true, profile: 'kept' })
            if (req.url === '/egress' && body?.stream === true) {
                if (mode.holdStream) return held.stream.push(res)
                res.writeHead(200, { 'content-type': 'application/x-ndjson' })
                return res.end(`${JSON.stringify({ type: 'head', status: 200, url: body.url, redirected: false, headers: {}, cookies: [] })}\n${JSON.stringify({ type: 'end', cookies: [] })}\n`)
            }
            if (req.url === '/egress') {
                if (mode.holdEgress) return held.egress.push(res)
                return jsonTo(res, 200, { status: 200, headers: {}, body: '{"success":true}', url: body.url, redirected: false, cookies: [] })
            }
            jsonTo(res, 500, { code: 'browser_error', message: 'Not this test’s subject.' })
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const saved = config.signinWorkerUrl
    config.signinWorkerUrl = `http://127.0.0.1:${server.address().port}`
    t.after(async () => {
        config.signinWorkerUrl = saved
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    })
    return { requests, held, mode, routes: () => [...requests] }
}

let sequence = 0

/** An account the app holds, replaced after the test by whatever it held before. */
async function withAccount(t, fn) {
    const original = accountManager.accountTokens
    const email = `paths-${++sequence}@example.invalid`
    const account = { email, password: 'synthetic', token: TOKEN, expires: exp() }
    accountManager.accountTokens = [account]
    accountManager.accountRotator.setAccounts([account])
    t.after(() => {
        accountManager.accountTokens = original
        accountManager.accountRotator.setAccounts(original)
        registry.removedAccounts.clear()
        v2sessions.deleteSession(email)
        sessionPersistence.resetRecoveryForTests()
    })
    await fn({ email, account })
}

const fakeRes = () => {
    const res = { statusCode: 200, headers: {}, body: null, headersSent: false, writableEnded: false }
    res.status = (code) => { res.statusCode = code; return res }
    res.set = (key, value) => {
        if (key && typeof key === 'object') Object.assign(res.headers, key)
        else res.headers[key] = value
        return res
    }
    res.json = (payload) => { res.body = payload; res.headersSent = true; res.writableEnded = true; return res }
    res.write = () => true
    res.end = () => { res.writableEnded = true }
    res.flushHeaders = () => { res.headersSent = true }
    res.removeHeader = (name) => { delete res.headers[name] }
    res.on = () => res
    return res
}

test('the periodic token refresh of a removed account — TokenManager.batchRefreshTokens — asks the worker for nothing', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        // The timer's refresh works on a snapshot: the account as the manager held it before the removal.
        const { refreshed, failed } = await accountManager.tokenManager.batchRefreshTokens([{ ...account }], 24)
        assert.deepEqual(refreshed, [], 'nothing was refreshed')
        assert.deepEqual(failed.map(item => item.email), [email])
        // No renewal and no sign-in for the account that is gone.
        assert.deepEqual(worker.routes(), ['/forget'])
    })
})

test('the Anthropic route, with the account removed while it was making the chat: the worker is asked for nothing but the forget', { timeout: 20000 }, async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account }) => {
        v2sessions.setSession(email, { token: TOKEN, expiresAt: exp(), jar: null })
        // A picture makes the request the account's: it is uploaded from the account's page, and the chat is made on it (Qwen2API-fjk).
        t.mock.method(uploadModule, 'uploadFileToQwenOss', async () => ({ status: 200, file_url: 'https://example.invalid/a.png', file_id: 'f1' }))

        worker.mode.holdEgress = true
        const res = fakeRes()
        const handling = handleAnthropicMessages({
            body: {
                model: 'qwen3-max', max_tokens: 64, stream: false,
                messages: [{ role: 'user', content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('a cat').toString('base64') } },
                    { type: 'text', text: 'what is it?' }
                ] }]
            }
        }, res).catch(error => ({ error }))
        // The chat is being made from the account's page.
        await until(() => worker.held.egress.length === 1, 5000, 'the chats/new reaching the worker')
        worker.mode.holdEgress = false

        assert.equal(await accountManager.removeAccount(email), true)
        jsonTo(worker.held.egress[0], 404, NO_PROFILE)
        const outcome = await within(handling, 10000, 'the request')

        // No renewal and no sign-in for the account that is gone: the chats/new that was out, and the forget.
        assert.deepEqual(worker.routes(), ['/egress', '/forget'])
        assert.equal(outcome?.error, undefined, `the request was answered, not thrown: ${outcome?.error?.stack || ''}`)
        assert.deepEqual([res.statusCode, res.body?.error?.code], [503, 'upstream_transport_error'],
            'a request that did not get through — a 503 the client may retry — as chats/new of a removed account ends')
        // Said once as what it is.
        assert.equal(lines.warn.filter(line => line.includes('was removed from the app') && line.includes(email)).length, 1)
    })
})
