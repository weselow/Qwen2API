const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { CookieJar } = require('tough-cookie')

// A password sign-in that the session's recovery makes while the account's
// periodic token refresh is out too (Qwen2API-cke). The sign-in is spent the
// moment its password is sent; what it harvests must not be lost:
// - the recovery publishes it first and the refresh ends last: the account
//   record used to end with the refresh's token all the same — the adoption
//   of the recovered token ran outside the account's queue of mutations and
//   was overtaken by the refresh;
// - the refresh ends first with what the worker still holds — the refused
//   token, published as a new object: the recovery took that object for a
//   newer session and dropped the sign-in's result, leaving the refused one
//   in place.
// Browser mode, as on prod, with file storage in a temporary directory; the
// worker is a stand-in on loopback that writes down each request and can hold
// one until the test lets it go.
process.env.API_KEY = 'recovery-refresh-race-test'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.DATA_SAVE_MODE = 'none' // file, inside the fixture
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''
// The recovery's waits are read from the environment: a value set outside would move them.
delete process.env.V2_SESSION_RELOGIN_MIN_INTERVAL_MS
delete process.env.V2_SESSION_RECOVERY_MIN_INTERVAL_MS

const config = require('../src/config')
const DataPersistence = require('../src/utils/data-persistence')
const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const sessionPersistence = require('../src/utils/v2-session-persistence')
const registry = require('../src/utils/account-registry')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const HOUR = 3600
const live = () => Math.floor(Date.now() / 1000) + HOUR
// Every token is its own: what holds which is told apart by it.
const tokenOf = n => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: live(), n })).toString('base64url')}.signature`
const REFUSED = tokenOf(1)
const SIGN_IN = tokenOf(2)
const REFRESH = tokenOf(3)
const sessionOf = token => ({ token, expiresAt: live(), jar: new CookieJar() })

// Nothing a test waits for may keep it for ever.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
    Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

// What is awaited after something else: kept from becoming an unhandled rejection should the test fail first.
const later = promise => {
    promise.catch(() => {})
    return promise
}

async function until(condition, timeoutMs = 5000, what = 'condition') {
    if (typeof timeoutMs !== 'number') throw new TypeError(`until(condition, timeoutMs, what): the second argument is the timeout in ms, got ${typeof timeoutMs}`)
    const deadline = Date.now() + timeoutMs
    while (!(await Promise.resolve().then(condition).catch(() => false))) {
        if (Date.now() > deadline) throw new Error(`${what} not met in ${timeoutMs} ms`)
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

/**
 * The worker as far as these tests are concerned. A forced /renew — the
 * session was refused — answers that the profile is lost, as a dead one
 * does; an unforced one answers what the worker still holds: the refused
 * token. `mode` holds a route until the test answers it with `answer`.
 */
async function standIn(t) {
    // `cached` is what an unforced /renew answers: the worker's own session — the refused token still.
    const worker = { routes: [], cached: REFUSED, mode: { holdRenew: false, holdSession: false }, held: { renew: [], session: [] } }
    const jsonTo = (res, status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
        res.end(text)
    }
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null
            worker.routes.push(req.url)
            if (req.url === '/renew' && body?.force === true) return jsonTo(res, 500, { code: 'no_profile', message: 'No persisted profile for this account.' })
            if (req.url === '/renew') {
                if (worker.mode.holdRenew) return worker.held.renew.push(res)
                return jsonTo(res, 200, { token: worker.cached, expiresAt: live(), cookies: [] })
            }
            if (req.url === '/session') {
                if (worker.mode.holdSession) return worker.held.session.push(res)
                return jsonTo(res, 200, { token: SIGN_IN, expiresAt: live(), cookies: [] })
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
    // The held request of a route is answered as the worker would have answered it.
    worker.answer = async (route, token) => {
        const res = worker.held[route].shift()
        assert.ok(res, `no /${route} is held`)
        jsonTo(res, 200, { token, expiresAt: live(), cookies: [] })
    }
    return worker
}

let sequence = 0

/** The app holding one account whose session the upstream refused; `stored()` and `record()` read what storage holds. */
async function withAccount(t, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-recovery-refresh-'))
    const persistence = new DataPersistence()
    persistence.dataFilePath = path.join(dir, 'data.json')
    persistence.backupFilePath = `${persistence.dataFilePath}.bak`
    persistence.v2SessionsFilePath = path.join(dir, 'v2-sessions.json')
    // The session persistence has an instance of its own: the same files.
    const sessions = sessionPersistence.persistence
    const original = {
        mode: config.dataSaveMode,
        persistence: accountManager.dataPersistence,
        accounts: accountManager.accountTokens,
        paths: [sessions.dataFilePath, sessions.backupFilePath, sessions.v2SessionsFilePath]
    }
    const email = `race-${++sequence}@example.invalid`
    const account = { email, password: 'synthetic', token: REFUSED, expires: live() }
    const data = JSON.stringify({ accounts: [account], settings: {}, defaultHeaders: {} })
    await fs.writeFile(persistence.dataFilePath, data)
    await fs.writeFile(persistence.backupFilePath, data)
    config.dataSaveMode = 'file'
    accountManager.dataPersistence = persistence
    accountManager.accountTokens = [account]
    accountManager.accountRotator.setAccounts([account])
    ;[sessions.dataFilePath, sessions.backupFilePath, sessions.v2SessionsFilePath] =
        [persistence.dataFilePath, persistence.backupFilePath, persistence.v2SessionsFilePath]
    const stored = async () => (await persistence.loadV2Sessions())[email]
    const record = async () => (JSON.parse(await fs.readFile(persistence.dataFilePath, 'utf8')).accounts
        .find(item => item.email === email)).token
    try {
        await sessionPersistence.publishSession(email, sessionOf(REFUSED))
        await fn({ email, account, persistence, stored, record })
    } finally {
        for (const timer of persistence._statsPersistTimers.values()) clearTimeout(timer)
        v2sessions.clearSessions()
        sessionPersistence.resetRecoveryForTests()
        config.dataSaveMode = original.mode
        accountManager.dataPersistence = original.persistence
        accountManager.accountTokens = original.accounts
        accountManager.accountRotator.setAccounts(original.accounts)
        ;[sessions.dataFilePath, sessions.backupFilePath, sessions.v2SessionsFilePath] = original.paths
        registry.removedAccounts.clear()
        assert.equal(path.dirname(dir), os.tmpdir())
        await fs.rm(dir, { recursive: true, force: true })
    }
}

const accountHeld = email => accountManager.accountTokens.find(account => account.email === email)?.token

/** The refresh is out at the worker while the recovery makes its sign-in and publishes its session; then the refresh ends. */
async function refreshEndsLast(t, fn) {
    const worker = await standIn(t)
    await withAccount(t, async (held) => {
        worker.mode.holdRenew = true
        const refresh = later(within(accountManager.refreshAccountToken(held.email), 10000, 'the refresh'))
        await until(() => worker.held.renew.length === 1, 5000, 'the refresh reaching the worker')
        // The request's recovery: the profile is lost, and a password sign-in follows.
        const recovery = later(within(sessionPersistence.recoverSession(held.email, held.account, 'upstream_session_unauthorized'), 10000, 'the recovery'))
        await until(() => v2sessions.sessions.get(held.email)?.token === SIGN_IN, 5000, 'the recovery publishing the sign-in’s session')
        await fn({ ...held, worker, refresh, recovery })
    })
}

test('the periodic refresh is out at the worker, the recovery publishes the sign-in’s session, the refresh ends with a token of its own: the sign-in’s result is kept — in the store, in storage and on the account record', { timeout: 15000 }, async t => {
    await refreshEndsLast(t, async ({ email, worker, refresh, recovery, stored, record }) => {
        await worker.answer('renew', REFRESH)
        assert.equal(await refresh, true)
        assert.equal((await recovery)?.token, SIGN_IN, 'the recovery hands back the sign-in’s session')
        assert.equal(v2sessions.sessions.get(email)?.token, SIGN_IN, 'the store holds the sign-in’s session')
        assert.equal((await stored())?.token, SIGN_IN, 'and so does storage')
        assert.equal(await record(), SIGN_IN, 'and so does the account record')
        assert.equal(accountHeld(email), SIGN_IN, 'in memory as on record')
    })
})

test('the same, and the refresh ends with what the worker still holds — the refused token: it does not put that back over the sign-in’s session', { timeout: 15000 }, async t => {
    await refreshEndsLast(t, async ({ email, worker, refresh, recovery, stored, record }) => {
        await worker.answer('renew', REFUSED)
        assert.equal(await refresh, true)
        assert.equal((await recovery)?.token, SIGN_IN)
        assert.equal(v2sessions.sessions.get(email)?.token, SIGN_IN, 'the store holds the sign-in’s session')
        assert.equal((await stored())?.token, SIGN_IN, 'and so does storage')
        assert.equal(await record(), SIGN_IN, 'and so does the account record')
        assert.equal(accountHeld(email), SIGN_IN)
    })
})

test('a refresh that began after the recovery published its session, and ended before the record’s adoption ran: the record follows the store', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account, stored, record }) => {
        // The publication's write to storage is held: the recovery has set its session in the store, and has not gone on to the adoption.
        let release
        let announce
        const gate = new Promise(resolve => { release = resolve })
        const entered = new Promise(resolve => { announce = resolve })
        const write = sessionPersistence.persistence.saveV2Session
        t.mock.method(sessionPersistence.persistence, 'saveV2Session', async function (email, session, options) {
            if (session?.token === SIGN_IN) { announce(); await gate }
            return write.call(this, email, session, options)
        })
        const recovery = later(within(sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), 10000, 'the recovery'))
        await within(entered, 5000, 'the publication reaching storage')
        worker.cached = REFRESH
        assert.equal(await within(accountManager.refreshAccountToken(email), 5000, 'the refresh'), true)
        assert.equal(v2sessions.sessions.get(email)?.token, REFRESH, 'the store holds the refresh’s session')
        assert.equal(await record(), REFRESH)
        release()
        assert.equal((await recovery)?.token, SIGN_IN)
        assert.equal(v2sessions.sessions.get(email)?.token, REFRESH, 'the store still holds the refresh’s session')
        assert.equal(await record(), REFRESH, 'and the record follows the store, not a session it no longer holds')
        assert.equal(accountHeld(email), REFRESH)
    })
})

test('the refresh ends first with the refused token the worker still holds, published as a new object: that is not a newer session — the sign-in’s result is published, not dropped', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account, stored, record }) => {
        worker.mode.holdSession = true
        const recovery = later(within(sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), 10000, 'the recovery'))
        await until(() => worker.held.session.length === 1, 5000, 'the sign-in reaching the worker')
        const refused = v2sessions.sessions.get(email)
        assert.equal(await within(accountManager.refreshAccountToken(email), 5000, 'the refresh'), true)
        assert.notEqual(v2sessions.sessions.get(email), refused, 'the refresh published a new object')
        assert.equal(v2sessions.sessions.get(email)?.token, REFUSED, 'and it holds the refused token still')
        await worker.answer('session', SIGN_IN)
        assert.equal((await recovery)?.token, SIGN_IN, 'the recovery hands back the sign-in’s session, not nothing')
        assert.equal(v2sessions.sessions.get(email)?.token, SIGN_IN, 'the store holds the sign-in’s session')
        assert.equal((await stored())?.token, SIGN_IN, 'and so does storage')
        assert.equal(await record(), SIGN_IN, 'and so does the account record')
        assert.equal(accountHeld(email), SIGN_IN)
    })
})

test('a session published meanwhile with a token of its own is newer than the recovery: the recovery displaces it with nothing', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account, stored }) => {
        worker.mode.holdSession = true
        const recovery = later(within(sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), 10000, 'the recovery'))
        await until(() => worker.held.session.length === 1, 5000, 'the sign-in reaching the worker')
        // A sign-in of the app's own — an adding — publishes a session while the recovery is out.
        const login = tokenOf(4)
        await sessionPersistence.publishSession(email, sessionOf(login))
        await worker.answer('session', SIGN_IN)
        assert.equal(await recovery, null, 'the caller is handed nothing the store does not hold')
        assert.equal(v2sessions.sessions.get(email)?.token, login)
        assert.equal((await stored())?.token, login)
    })
})

test('the record’s adoption of a recovered token and the account’s refresh go one at a time: a refresh that comes up while the adoption saves waits for it', { timeout: 15000 }, async t => {
    await standIn(t)
    await withAccount(t, async ({ email, persistence, record }) => {
        let release
        let announce
        const gate = new Promise(resolve => { release = resolve })
        const entered = new Promise(resolve => { announce = resolve })
        const save = persistence.saveAccount
        t.mock.method(persistence, 'saveAccount', async function (email, data, options) {
            if (data?.token === SIGN_IN) { announce(); await gate }
            return save.call(this, email, data, options)
        })
        const refreshes = []
        t.mock.method(accountManager.tokenManager, 'refreshToken', async account => {
            refreshes.push(account.token)
            return { ...account, token: REFRESH, expires: live() }
        })
        // The session being adopted is the one the store holds, as a recovery's is when it adopts it.
        await sessionPersistence.publishSession(email, sessionOf(SIGN_IN))
        const adoption = later(within(accountManager.adoptSessionToken(email, sessionOf(SIGN_IN)), 10000, 'the adoption'))
        await within(entered, 5000, 'the adoption reaching storage')
        const refresh = later(within(accountManager.refreshAccountToken(email), 10000, 'the refresh'))
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.deepEqual(refreshes, [], 'the refresh waited for the adoption')
        release()
        assert.equal(await adoption, true)
        assert.equal(await refresh, true)
        // The refresh ran after the adoption: it found the token the adoption had put on record.
        assert.deepEqual(refreshes, [SIGN_IN])
        assert.equal(await record(), REFRESH)
    })
})
