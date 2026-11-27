const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { CookieJar } = require('tough-cookie')

// An account removed from the app and added again (Qwen2API-jwh). Its sign-in
// publishes the session before the new record is saved — and storage refused
// it until then, as it refuses every late session of a removed account
// (Qwen2API-u50). So the account was added, but had no stored session until
// its first token rotation, and a restart inside that window cost a password
// sign-in. The sign-in that adds an account is the one write storage takes;
// any other is still refused. Browser mode, as on prod, with file storage in
// a temporary directory; the worker is a stand-in on loopback that writes down
// every request it is asked.
process.env.API_KEY = 'account-readded-session-test'
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
const router = require('../src/routes/accounts')
const { logger } = require('../src/utils/logger')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const HOUR = 3600
const live = () => Math.floor(Date.now() / 1000) + HOUR
// Every token is its own: what storage holds is told apart by the sign-in that harvested it.
const tokenOf = n => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: live(), n })).toString('base64url')}.signature`

// The routes as express holds them, called the way express calls them (the key check is not this file's subject).
const handlerOf = (method, url) => router.stack
    .find(layer => layer.route?.path === url && layer.route.methods[method]).route.stack.at(-1).handle
const addAccount = handlerOf('post', '/setAccount')
const addAccounts = handlerOf('post', '/setAccounts')
const removeAccount = handlerOf('delete', '/deleteAccount')

async function call(handler, body) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this },
        json(payload) { this.body = payload; return this }
    }
    await handler({ body }, res)
    return res
}

// A deadline for what is waited for by condition; the rest is bounded by the tests' own timeout.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
    Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

// What the app says while a test runs.
function capture(t) {
    const lines = { warn: [], error: [] }
    const saved = { warn: logger.warn, error: logger.error }
    logger.warn = message => lines.warn.push(String(message))
    logger.error = message => lines.error.push(String(message))
    t.after(() => Object.assign(logger, saved))
    return lines
}

/**
 * The worker as far as these tests are concerned: a sign-in answers with a
 * session of its own each time, a forget is answered, and each request is
 * written down. `tokens` holds what each sign-in harvested, in order.
 */
async function standIn(t) {
    const worker = { routes: [], tokens: [] }
    const server = http.createServer((req, res) => {
        // The body is not this file's subject; it is drained so that the request ends.
        req.resume()
        req.on('end', () => {
            worker.routes.push(req.url)
            const answer = (status, payload) => {
                const text = JSON.stringify(payload)
                res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
                res.end(text)
            }
            if (req.url === '/session') {
                const token = tokenOf(worker.tokens.length + 1)
                worker.tokens.push(token)
                return answer(200, { token, expiresAt: live(), cookies: [] })
            }
            if (req.url === '/forget') return answer(200, { ok: true, session: true, page: true, profile: 'kept' })
            return answer(500, { code: 'browser_error', message: 'Not this test’s subject.' })
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
    return worker
}

/** File storage in a temporary directory, the app holding no account; `stored()` reads what storage holds. */
async function withStorage(t, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-account-readded-'))
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
    const empty = JSON.stringify({ accounts: [], settings: {}, defaultHeaders: {} })
    await fs.writeFile(persistence.dataFilePath, empty)
    await fs.writeFile(persistence.backupFilePath, empty)
    config.dataSaveMode = 'file'
    accountManager.dataPersistence = persistence
    accountManager.accountTokens = []
    accountManager.accountRotator.setAccounts([])
    ;[sessions.dataFilePath, sessions.backupFilePath, sessions.v2SessionsFilePath] =
        [persistence.dataFilePath, persistence.backupFilePath, persistence.v2SessionsFilePath]
    const stored = async () => (await persistence.loadV2Sessions()) || {}
    try { await fn({ persistence, stored }) } finally {
        for (const timer of persistence._statsPersistTimers.values()) clearTimeout(timer)
        v2sessions.clearSessions()
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

/**
 * Every write of a session the app makes while the test runs — all of them go through
 * the session persistence's own instance — with the options it was given. `mark()` says where
 * the writes made from then on begin; `settled(since)` waits for those and
 * hands them back.
 */
function watchSessionWrites(t) {
    const writes = []
    for (const persistence of [accountManager.dataPersistence, sessionPersistence.persistence]) {
        const write = persistence.saveV2Session
        t.mock.method(persistence, 'saveV2Session', function (email, session, options) {
            const done = Promise.resolve(write.call(this, email, session, options))
            writes.push({ email, allowCreate: options?.allowCreate === true, done })
            return done
        })
    }
    return {
        mark: () => writes.length,
        settled: async (since = 0) => {
            const done = writes.slice(since)
            return Promise.all(done.map(async write => ({ email: write.email, allowCreate: write.allowCreate, saved: await write.done })))
        }
    }
}

const PASSWORD = 'synthetic'

test('removed and added again: its session is stored by the sign-in that adds it — one sign-in, no warning, and it is there after a restart', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withStorage(t, async ({ stored }) => {
        const email = 'readded@example.invalid'
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 200)
        assert.equal((await stored())[email]?.token, worker.tokens[0])
        assert.equal((await call(removeAccount, { email })).statusCode, 200)
        assert.equal((await stored())[email], undefined, 'the removal dropped the stored session')

        const lines = capture(t)
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 200)

        assert.deepEqual(worker.routes, ['/session', '/forget', '/session'], 'one sign-in for each adding')
        assert.equal((await stored())[email]?.token, worker.tokens[1], 'the session on record is the second sign-in’s')
        assert.equal(v2sessions.sessions.get(email)?.token, worker.tokens[1])
        assert.equal(lines.warn.filter(line => line.includes('v2 会话持久化失败')).length, 0, 'no persistence warning')
        assert.deepEqual(lines.error, [])
        // The app restarts inside the window that used to lose the session.
        v2sessions.clearSessions()
        assert.equal(await sessionPersistence.restoreSessions(), 1)
        assert.equal(v2sessions.sessions.get(email)?.token, worker.tokens[1])
    })
})

test('the bulk adding road stores the session of an account added again the same way', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    await withStorage(t, async ({ stored }) => {
        const email = 'readded-bulk@example.invalid'
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 200)
        assert.equal((await call(removeAccount, { email })).statusCode, 200)
        assert.equal((await stored())[email], undefined)
        const lines = capture(t)
        const res = await call(addAccounts, { accounts: `${email}:${PASSWORD}` })
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.success, 1, JSON.stringify(res.body))
        assert.equal((await stored())[email]?.token, worker.tokens[1])
        assert.equal(lines.warn.filter(line => line.includes('v2 会话持久化失败')).length, 0)
    })
})

test('removed and not added again: nothing puts its session back into storage — a late publication, and the jar sync after it', { timeout: 15000 }, async t => {
    const worker = await standIn(t)
    const writes = watchSessionWrites(t)
    await withStorage(t, async ({ stored }) => {
        const email = 'not-again@example.invalid'
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 200)
        assert.equal((await call(removeAccount, { email })).statusCode, 200)
        assert.equal(registry.accountRemoved(email), true)

        // What a renewal of the removed account, still out when it was removed, publishes when it ends.
        const late = { token: tokenOf(99), expiresAt: live(), jar: new CookieJar() }
        const mark = writes.mark()
        assert.equal(await within(sessionPersistence.publishSession(email, late)), false)
        assert.equal((await stored())[email], undefined)
        sessionPersistence.syncCookies(email, [{ name: 'late', value: '1', domain: '.qwen.ai', path: '/', secure: true }])
        const made = (await within(writes.settled(mark))).filter(write => write.email === email)
        assert.deepEqual(made.map(write => [write.allowCreate, write.saved]),
            [[false, false], [false, false]], 'the publication and the jar sync both reached storage, and both were refused')
        assert.equal((await stored())[email], undefined)

        // A sign-in that is not an adding publishes nothing there either.
        assert.equal(await accountManager.login(email, PASSWORD, null), worker.tokens[1])
        assert.equal((await stored())[email], undefined)
        assert.deepEqual(worker.routes, ['/session', '/forget', '/session'])
    })
})

test('a re-add whose record storage refuses leaves the account removed — its sign-in’s session goes with it, and a late one is refused', { timeout: 15000 }, async t => {
    await standIn(t)
    const writes = watchSessionWrites(t)
    await withStorage(t, async ({ persistence, stored }) => {
        const email = 'unsaved-again@example.invalid'
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 200)
        assert.equal((await call(removeAccount, { email })).statusCode, 200)
        // Storage answers the record of the re-add with a refusal, as a full disk would.
        const saveAccount = persistence.saveAccount
        t.mock.method(persistence, 'saveAccount', function (email, data, options) {
            return options?.allowCreate ? Promise.resolve(false) : saveAccount.call(this, email, data, options)
        })
        const mark = writes.mark()
        assert.equal((await call(addAccount, { email, password: PASSWORD })).statusCode, 500)
        assert.equal(accountManager.accountTokens.some(account => account.email === email), false)
        assert.equal(registry.accountRemoved(email), true)
        // The account is not the app's: nothing of that sign-in stays behind.
        assert.equal(v2sessions.sessions.has(email), false, 'the session of the adding that failed is not left in the store')
        const late = { token: tokenOf(98), expiresAt: live(), jar: new CookieJar() }
        assert.equal(await within(sessionPersistence.publishSession(email, late)), false)
        const made = (await within(writes.settled(mark))).filter(write => write.email === email)
        assert.deepEqual(made.map(write => [write.allowCreate, write.saved]),
            [[true, true], [false, false]], 'the sign-in’s own session was written, the late one was refused')
        assert.equal((await stored())[email], undefined, 'nor in storage')
    })
})
