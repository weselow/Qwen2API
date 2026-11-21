const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const { CookieJar } = require('tough-cookie')

// Stub the signin-worker client BEFORE anything pulls the real one in: the
// persistence module requires it at load time, and every renewal scenario
// below drives these impls.
let renewImpl = async () => { throw new Error('renewImpl not configured') }
let acquireImpl = async () => { throw new Error('acquireImpl not configured') }
const workerCalls = { renew: [], acquire: [] }
const workerPath = require.resolve('../src/utils/signin-worker-client')
const workerStub = new Module(workerPath)
workerStub.filename = workerPath
workerStub.loaded = true
workerStub.exports = {
    renewSession: async (email, account) => {
        workerCalls.renew.push(email)
        const harvested = await renewImpl(email, account)
        return { token: harvested.token, expiresAt: harvested.expiresAt, jar: jarWith(harvested.cookie || 'renewed=1') }
    },
    acquireSession: async (email, password, account) => {
        workerCalls.acquire.push(email)
        const harvested = await acquireImpl(email, password, account)
        return { token: harvested.token, expiresAt: harvested.expiresAt, jar: jarWith(harvested.cookie || 'acquired=1') }
    }
}
require.cache[workerPath] = workerStub

function jarWith(cookieString = 'restored=yes') {
    const jar = new CookieJar()
    jar.setCookieSync(`${cookieString}; Domain=.qwen.ai; Path=/; Secure`, 'https://chat.qwen.ai/')
    return jar
}

const tokenWith = (exp) =>
    'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'a@example.invalid', exp })).toString('base64url') + '.fixture'

// Each scenario re-requires the config-bound modules with a controlled env
// (same pattern as v2-session-store.test.js; test files run in their own
// process, so the purges never leak into other suites).
const MODULES = [
    '../src/config', '../src/utils/v2-session-store', '../src/utils/v2-lab-sessions',
    '../src/utils/data-persistence', '../src/utils/v2-session-persistence'
]
const ENV_KEYS = ['API_KEY', 'V2_SESSION_MODE', 'QWEN_LAB_V2_AUTH_ORIGIN', 'QWEN_CHAT_PROXY_URL',
    'DATA_SAVE_MODE', 'ENABLE_FILE_LOG', 'ENABLE_CLI']

function fresh(env) {
    const saved = {}
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key]
        if (env[key] === undefined) delete process.env[key]
        else process.env[key] = env[key]
    }
    for (const mod of MODULES) delete require.cache[require.resolve(mod)]
    return () => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
        for (const mod of MODULES) delete require.cache[require.resolve(mod)]
    }
}

const BROWSER_FILE = {
    API_KEY: 'v2-persist-test',
    V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai',
    DATA_SAVE_MODE: 'file',
    ENABLE_FILE_LOG: 'false',
    ENABLE_CLI: 'false'
}

// A scenario sandbox: fresh modules + tmpdir-backed persistence paths.
async function withBrowserFile(fn) {
    const restore = fresh(BROWSER_FILE)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-v2-sessions-'))
    try {
        const persistenceModule = require('../src/utils/v2-session-persistence')
        const store = require('../src/utils/v2-session-store')
        persistenceModule.persistence.dataFilePath = path.join(dir, 'data.json')
        persistenceModule.persistence.backupFilePath = `${path.join(dir, 'data.json')}.bak`
        persistenceModule.persistence.v2SessionsFilePath = path.join(dir, 'v2-sessions.json')
        const readSessionsFile = async () => JSON.parse(await fs.readFile(persistenceModule.persistence.v2SessionsFilePath, 'utf-8'))
        await fn({ persistenceModule, store, dir, readSessionsFile })
    } finally {
        restore()
        workerCalls.renew.length = 0
        workerCalls.acquire.length = 0
        assert.equal(path.dirname(dir), os.tmpdir())
        await fs.rm(dir, { recursive: true, force: true })
    }
}

test('publishSession writes a 0600 session file that restoreSessions revives after a restart', async () => {
    await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
        const email = 'live@example.invalid'
        const token = tokenWith(Math.floor(Date.now() / 1000) + 1800)
        const saved = await persistenceModule.publishSession(email, { token, expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith('persisted=1') })
        assert.equal(saved, true)
        assert.ok(store.sessionFor(email, token), 'session is live in memory right after publish')

        const onDisk = await readSessionsFile()
        assert.deepEqual(Object.keys(onDisk.sessions), [email])
        assert.equal(onDisk.sessions[email].token, token)
        if (process.platform !== 'win32') {
            const { mode } = await fs.stat(persistenceModule.persistence.v2SessionsFilePath)
            assert.equal(mode & 0o777, 0o600, 'bearer-token file must be owner-only')
        }

        // Simulated restart: fresh store, restore from the same file.
        store.clearSessions()
        assert.equal(store.sessions.size, 0)
        const restored = await persistenceModule.restoreSessions()
        assert.equal(restored, 1)
        const session = store.sessionFor(email, token)
        assert.ok(session, 'restored session matches the persisted token')
        const cookies = session.jar.getCookiesSync('https://chat.qwen.ai/api/v2/chats/new')
        assert.deepEqual(cookies.map(cookie => cookie.cookieString()), ['persisted=1'])
    })
})

test('restoreSessions prunes expired records from storage instead of reviving them', async () => {
    await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
        const liveToken = tokenWith(Math.floor(Date.now() / 1000) + 1800)
        await fs.writeFile(persistenceModule.persistence.v2SessionsFilePath, JSON.stringify({
            sessions: {
                'live@example.invalid': { token: liveToken, expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith().toJSON() },
                'dead@example.invalid': { token: tokenWith(1), expiresAt: 1, jar: jarWith().toJSON() }
            }
        }))
        const restored = await persistenceModule.restoreSessions()
        assert.equal(restored, 1)
        assert.ok(store.sessionFor('live@example.invalid', liveToken))
        assert.equal(store.sessionFor('dead@example.invalid', tokenWith(1)), null)
        assert.deepEqual(Object.keys((await readSessionsFile()).sessions), ['live@example.invalid'],
            'expired record is deleted from the file, not just skipped')
    })
})

test('a corrupt session file is quarantined and treated as empty — sessions are renewable, startup continues', async () => {
    await withBrowserFile(async ({ persistenceModule, store, dir }) => {
        await fs.writeFile(persistenceModule.persistence.v2SessionsFilePath, '{not json')
        assert.deepEqual(await persistenceModule.persistence.loadV2Sessions(), {})
        assert.equal(await persistenceModule.restoreSessions(), 0)
        const leftovers = (await fs.readdir(dir)).filter(name => name.startsWith('v2-sessions.json.corrupt-'))
        assert.equal(leftovers.length, 1, 'corrupt original is kept for forensics')
    })
})

test('invalidateSession drops memory + file and the renewal publishes a fresh persisted session', async () => {
    await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
        const email = 'renewed@example.invalid'
        const oldToken = tokenWith(Math.floor(Date.now() / 1000) + 1800)
        await persistenceModule.publishSession(email, { token: oldToken, expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith('old=1') })

        const nextToken = tokenWith(Math.floor(Date.now() / 1000) + 3600)
        renewImpl = async () => ({ token: nextToken, expiresAt: Math.floor(Date.now() / 1000) + 3600, cookie: 'fresh=1' })

        persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized')
        assert.equal(store.sessionFor(email, oldToken), null, 'invalidated session leaves the store immediately')
        await persistenceModule.renewals.get(email)
        assert.deepEqual(workerCalls.renew, [email])

        const session = store.sessionFor(email, nextToken)
        assert.ok(session, 'renewal published the fresh token')
        assert.deepEqual(session.jar.getCookiesSync('https://chat.qwen.ai/x').map(cookie => cookie.cookieString()), ['fresh=1'])
        const onDisk = await readSessionsFile()
        assert.equal(onDisk.sessions[email].token, nextToken, 'fresh session reached storage')
    })
})

test('a dead browser profile falls back to a full password sign-in during renewal', async () => {
    await withBrowserFile(async ({ persistenceModule, store }) => {
        const email = 'lost@example.invalid'
        await persistenceModule.publishSession(email, { token: tokenWith(Math.floor(Date.now() / 1000) + 1800), expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith() })
        const freshToken = tokenWith(Math.floor(Date.now() / 1000) + 3600)
        renewImpl = async () => {
            const failure = new Error('no_profile')
            failure.sessionLost = true
            throw failure
        }
        acquireImpl = async () => ({ token: freshToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
        persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_waf_challenge')
        await persistenceModule.renewals.get(email)
        assert.deepEqual(workerCalls.renew, [email])
        assert.deepEqual(workerCalls.acquire, [email])
        assert.ok(store.sessionFor(email, freshToken))
    })
})

test('a failed renewal leaves no session and never throws into the request path', async () => {
    await withBrowserFile(async ({ persistenceModule, store }) => {
        const email = 'doomed@example.invalid'
        await persistenceModule.publishSession(email, { token: tokenWith(Math.floor(Date.now() / 1000) + 1800), expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith() })
        renewImpl = async () => { throw new Error('signin-worker down') }
        const drop = persistenceModule.invalidateSession(email, { email, password: 'pw' }, 401)
        const renewal = persistenceModule.renewals.get(email)
        assert.ok(renewal)
        await drop
        assert.ok(renewal)
        await renewal
        assert.equal(store.sessions.size, 0, 'old session stays invalidated, no new one appears')
        const onDisk = JSON.parse(await fs.readFile(persistenceModule.persistence.v2SessionsFilePath, 'utf-8'))
        assert.deepEqual(onDisk.sessions, {}, 'invalidated session is gone from storage too')
    })
})

test('parallel invalidations trigger exactly one renewal, and a renewal never displaces a newer session', async () => {
    await withBrowserFile(async ({ persistenceModule, store }) => {
        const email = 'raced@example.invalid'
        await persistenceModule.publishSession(email, { token: tokenWith(Math.floor(Date.now() / 1000) + 1800), expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith() })

        let releaseRenew
        const gate = new Promise(resolve => { releaseRenew = resolve })
        const nextToken = tokenWith(Math.floor(Date.now() / 1000) + 3600)
        renewImpl = async () => {
            await gate
            return { token: nextToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
        }
        persistenceModule.invalidateSession(email, { email }, 'upstream_session_unauthorized')
        persistenceModule.invalidateSession(email, { email }, 'upstream_waf_challenge')

        // While the renewal is in flight, a concurrent login publishes a newer session.
        const loginToken = tokenWith(Math.floor(Date.now() / 1000) + 5400)
        await persistenceModule.publishSession(email, { token: loginToken, expiresAt: Math.floor(Date.now() / 1000) + 5400, jar: jarWith('login=1') })
        releaseRenew()
        await persistenceModule.renewals.get(email)

        assert.deepEqual(workerCalls.renew, [email], 'both invalidations shared one worker call')
        assert.ok(store.sessionFor(email, loginToken), 'the concurrent login session wins')
        assert.equal(store.sessionFor(email, nextToken), null, 'stale renewal result is discarded')
    })
})

test('account deletion drops the stored session and a late renewal cannot resurrect it', async () => {
    await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
        const email = 'removed@example.invalid'
        const persistence = persistenceModule.persistence
        assert.equal(await persistence.saveAccount(email, { password: 'pw', token: tokenWith(Math.floor(Date.now() / 1000) + 1800) }, { allowCreate: true }), true)
        await persistenceModule.publishSession(email, { token: tokenWith(Math.floor(Date.now() / 1000) + 1800), expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith() })

        assert.equal(await persistence.deleteAccount(email), true)
        assert.deepEqual((await readSessionsFile()).sessions, {}, 'deleting the account wipes its session record')
        // in-memory store cleanup is accountManager.removeAccount's job
        // (lab.sessions === store.sessions, same Map identity) — storage here
        // only guarantees the record is gone from disk.

        // A renewal that was already in flight when the account was removed
        // must not write the bearer token back to storage.
        assert.equal(await persistence.saveV2Session(email, { token: 'ghost', expiresAt: 1, jar: jarWith().toJSON() }), false)
        assert.deepEqual((await readSessionsFile()).sessions, {})
    })
})

test('off mode: publish, invalidate and restore are all inert', async () => {
    const restore = fresh({ API_KEY: 'v2-persist-test', V2_SESSION_MODE: 'off', QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai', DATA_SAVE_MODE: 'file', ENABLE_FILE_LOG: 'false' })
    try {
        const persistenceModule = require('../src/utils/v2-session-persistence')
        const store = require('../src/utils/v2-session-store')
        assert.equal(await persistenceModule.publishSession('x@example.invalid', { token: 't', expiresAt: 1, jar: jarWith() }), false)
        assert.equal(store.sessions.size, 0)
        persistenceModule.invalidateSession('x@example.invalid', { email: 'x@example.invalid' }, 401)
        assert.equal(persistenceModule.renewals.size, 0)
        assert.equal(await persistenceModule.restoreSessions(), 0)
    } finally {
        restore()
    }
})

test('browser mode without storage (none) keeps sessions memory-only, like before jik.4', async () => {
    const restore = fresh({ API_KEY: 'v2-persist-test', V2_SESSION_MODE: 'browser', QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai', DATA_SAVE_MODE: 'none', ENABLE_FILE_LOG: 'false' })
    try {
        const persistenceModule = require('../src/utils/v2-session-persistence')
        const store = require('../src/utils/v2-session-store')
        const token = tokenWith(Math.floor(Date.now() / 1000) + 1800)
        assert.equal(await persistenceModule.publishSession('mem@example.invalid', { token, expiresAt: 1, jar: jarWith() }), false)
        assert.ok(store.sessionFor('mem@example.invalid', token), 'memory store still works')
        assert.deepEqual(await persistenceModule.persistence.loadV2Sessions(), {})
    } finally {
        restore()
    }
})
