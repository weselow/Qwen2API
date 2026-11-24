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
const workerCalls = { renew: [], acquire: [], renewOptions: [] }
const workerPath = require.resolve('../src/utils/signin-worker-client')
const workerStub = new Module(workerPath)
workerStub.filename = workerPath
workerStub.loaded = true
workerStub.exports = {
    renewSession: async (email, account, options) => {
        workerCalls.renew.push(email)
        workerCalls.renewOptions.push(options)
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
        workerCalls.renewOptions.length = 0
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
        persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized')
        await persistenceModule.renewals.get(email)
        assert.deepEqual(workerCalls.renew, [email])
        assert.deepEqual(workerCalls.acquire, [email])
        assert.ok(store.sessionFor(email, freshToken))
    })
})

test('a WAF challenge is not a verdict on the session: nothing is dropped, nothing is renewed', async () => {
  await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
    const email = 'challenged@example.invalid'
    const token = tokenWith(live(1800))
    await persistenceModule.publishSession(email, { token, expiresAt: live(1800), jar: jarWith() })
    renewImpl = async () => ({ token: tokenWith(live(3600)), expiresAt: live(3600) })

    // The session stays exactly as it is, and the worker is not asked for anything.
    assert.equal(persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_waf_challenge'), undefined)
    assert.equal(persistenceModule.renewals.size, 0)
    assert.ok(store.sessionFor(email, token))
    assert.equal((await readSessionsFile()).sessions[email].token, token)
  })
})

test('a delete issued right after a save lands after it: an invalidated session is not written back', async () => {
  await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
    const email = 'ordered@example.invalid'
    const token = tokenWith(live(1800))
    await persistenceModule.publishSession(email, {
      token, expiresAt: live(1800), jar: store.jarFromCookies([browserCookie('cna', 'old')])
    })
    renewImpl = async () => { throw new Error('signin-worker down') }
    // What reaches the file, and when.
    const trace = []
    for (const name of ['_saveV2SessionToFile', '_deleteV2SessionFromFile']) {
      const original = persistenceModule.persistence[name].bind(persistenceModule.persistence)
      persistenceModule.persistence[name] = async (...args) => {
        trace.push(`${name}:start`)
        const result = await original(...args)
        trace.push(`${name}:end`)
        return result
      }
    }

    // A direct chats/new that qwen.ai refuses: its Set-Cookie changes the jar
    // (a save is queued) and the refusal drops the session — in the same tick.
    assert.equal(persistenceModule.syncCookies(email, [browserCookie('cna', 'rotated')]), true)
    const drop = persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized')
    await Promise.all([drop, persistenceModule.renewals.get(email)])

    // Asked for first, landed first: the delete that follows removes what the save wrote.
    // (Judged by the order, not by the file: two writes racing for one target
    // end differently on different file systems.)
    assert.deepEqual(trace, [
      '_saveV2SessionToFile:start', '_saveV2SessionToFile:end',
      '_deleteV2SessionFromFile:start', '_deleteV2SessionFromFile:end'
    ])
    assert.equal(store.sessions.get(email), undefined)
    assert.equal((await readSessionsFile()).sessions[email], undefined, 'nothing wrote the refused session back')
  })
})

test('a sign-in that fails is not repeated at once, and its wait doubles like a refused one', async () => {
  await withBrowserFile(async ({ persistenceModule, store }) => {
    const config = require('../src/config')
    const email = 'stuck@example.invalid'
    const token = tokenWith(live(1800))
    await persistenceModule.publishSession(email, { token, expiresAt: live(1800), jar: jarWith() })
    const account = { email, password: 'pw' }
    let now = Date.now()
    persistenceModule.setRecoveryClockForTests(() => now)
    config.sessionRecoveryMinIntervalMs = 0
    config.sessionReloginMinIntervalMs = 60000
    renewImpl = async () => { throw Object.assign(new Error('no_profile'), { sessionLost: true }) }
    acquireImpl = async () => { throw Object.assign(new Error('Qwen rejected the credentials.'), { code: 'signin_rejected' }) }
    try {
      const recover = () => persistenceModule.recoverSession(email, account, 'upstream_session_unauthorized')
      assert.equal(await recover(), null)
      assert.deepEqual(workerCalls.acquire, [email])
      now += 61_000
      assert.equal(await recover(), null)
      assert.deepEqual(workerCalls.acquire, [email], 'the failed attempt doubled the wait: not at the base minute any more')
      now += 60_000
      assert.equal(await recover(), null)
      assert.deepEqual(workerCalls.acquire, [email, email])
      // Nothing was recovered, so nothing replaced the session it started with.
      assert.equal(store.sessions.get(email).token, token)
    } finally {
      persistenceModule.setRecoveryClockForTests(null)
    }
  })
})

test('lab sessions are left alone: jar sync is browser mode\'s', () => {
  const restore = fresh({
    API_KEY: 'v2-persist-test', V2_SESSION_MODE: 'lab',
    QWEN_LAB_V2_AUTH_ORIGIN: 'https://auth.stand.test:8443', QWEN_CHAT_PROXY_URL: 'https://chat.stand.test:8443',
    DATA_SAVE_MODE: 'none', ENABLE_FILE_LOG: 'false'
  })
  try {
    const labStore = require('../src/utils/v2-session-store')
    const persistenceModule = require('../src/utils/v2-session-persistence')
    const email = 'lab@example.invalid'
    labStore.setSession(email, { token: 'lab-token', expiresAt: 1, jar: jarWith('lab=1') })
    assert.equal(persistenceModule.syncCookies(email, [browserCookie('cna', 'x')]), false)
    assert.equal(persistenceModule.readSetCookies(email, { 'set-cookie': 'cna=x' }, 'https://chat.qwen.ai/x'), false)
    assert.equal(persistenceModule.sessionToken({ email }, 'request-token'), 'request-token', 'a lab request keeps the token it holds')
    assert.deepEqual(labStore.sessions.get(email).jar.getCookiesSync('https://chat.qwen.ai/x').map(cookie => cookie.cookieString()), ['lab=1'])
  } finally {
    restore()
  }
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
    // Recovery and jar sync are browser mode's as well.
    const account = { email: 'x@example.invalid', password: 'pw' }
    assert.equal(await persistenceModule.recoverSession(account.email, account, 'upstream_session_unauthorized'), null)
    persistenceModule.escalateToRelogin(account.email, account, 'upstream_session_unauthorized')
    assert.equal(persistenceModule.syncCookies(account.email, [{ name: 'cna', value: 'x', domain: 'chat.qwen.ai', path: '/' }]), false)
    assert.equal(persistenceModule.readSetCookies(account.email, { 'set-cookie': 'cna=x' }, 'https://chat.qwen.ai/x'), false)
    // Where no store backs the account, a request keeps the token it holds.
    assert.equal(persistenceModule.sessionToken(account, 't'), 't')
    assert.equal(persistenceModule.sessionToken(null, 't'), 't')
    assert.equal(persistenceModule.renewals.size, 0)
    assert.deepEqual([workerCalls.renew, workerCalls.acquire], [[], []])
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

/* ------------------------------------------------ recovery (Qwen2API-3ue.2) -- */

const live = seconds => Math.floor(Date.now() / 1000) + seconds
const browserCookie = (name, value) => ({ name, value, domain: 'chat.qwen.ai', path: '/' })

test('a renewal after an invalidation is live — forced past the worker cache — and says so to the worker', async () => {
  await withBrowserFile(async ({ persistenceModule, store }) => {
    const email = 'forced@example.invalid'
    await persistenceModule.publishSession(email, { token: tokenWith(live(1800)), expiresAt: live(1800), jar: jarWith() })
    // Built once: a fixture minted twice is two tokens across a second boundary.
    const renewed = tokenWith(live(3600))
    renewImpl = async () => ({ token: renewed, expiresAt: live(3600) })

    persistenceModule.invalidateSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized')
    await persistenceModule.renewals.get(email)
    // The cached /renew is the no-op that replayed a refused jar on prod:
    // every recovery asks the worker for a reload.
    assert.deepEqual(workerCalls.renewOptions, [{ force: true }])
    assert.ok(store.sessionFor(email, renewed))
  })
})

test('a dead profile is re-logged in at most once per interval', async () => {
  await withBrowserFile(async ({ persistenceModule, store }) => {
    const config = require('../src/config')
    const email = 'throttled@example.invalid'
    const account = { email, password: 'pw' }
    const first = tokenWith(live(3600))
    const second = tokenWith(live(5400))
    config.sessionRecoveryMinIntervalMs = 0
    config.sessionReloginMinIntervalMs = 60000
    renewImpl = async () => { throw Object.assign(new Error('no_profile'), { sessionLost: true }) }
    acquireImpl = async () => ({ token: first, expiresAt: live(3600), cookie: 'first=1' })

    assert.ok(await persistenceModule.recoverSession(email, account, 'upstream_session_unauthorized'))
    assert.deepEqual(workerCalls.acquire, [email])
    // The recovery throttle is open, the re-login one is not: no second
    // password login, and the session the first recovery published stays.
    const session = store.sessions.get(email)
    assert.equal(await persistenceModule.recoverSession(email, account, 'upstream_session_unauthorized'), null)
    assert.deepEqual(workerCalls.acquire, [email])
    assert.equal(store.sessions.get(email), session)
    assert.deepEqual(session.jar.getCookiesSync('https://chat.qwen.ai/x').map(cookie => cookie.cookieString()), ['first=1'])

    // The window over: allowed again.
    config.sessionReloginMinIntervalMs = 0
    acquireImpl = async () => ({ token: second, expiresAt: live(5400) })
    assert.ok(await persistenceModule.recoverSession(email, account, 'upstream_session_unauthorized'))
    assert.deepEqual(workerCalls.acquire, [email, email])
    assert.ok(store.sessionFor(email, second))
  })
})

test('an account without a password cannot be re-logged in: the recovery says so and leaves the session alone', async () => {
  await withBrowserFile(async ({ persistenceModule, store }) => {
    const email = 'nopassword@example.invalid'
    const token = tokenWith(live(1800))
    await persistenceModule.publishSession(email, { token, expiresAt: live(1800), jar: jarWith('kept=1') })
    renewImpl = async () => { throw Object.assign(new Error('no_profile'), { sessionLost: true }) }

    assert.equal(await persistenceModule.recoverSession(email, { email }, 'upstream_session_unauthorized'), null)
    assert.deepEqual(workerCalls.acquire, [], 'the worker is not asked for a login that cannot succeed')
    assert.deepEqual(store.sessionFor(email, token).jar.getCookiesSync('https://chat.qwen.ai/x').map(cookie => cookie.cookieString()), ['kept=1'])
  })
})

test('a recovery never displaces a session published while it ran, and hands back nothing stale', async () => {
  await withBrowserFile(async ({ persistenceModule, store }) => {
    const email = 'raced-recovery@example.invalid'
    await persistenceModule.publishSession(email, { token: tokenWith(live(1800)), expiresAt: live(1800), jar: jarWith() })
    let releaseRenew
    const gate = new Promise(resolve => { releaseRenew = resolve })
    const renewedToken = tokenWith(live(3600))
    renewImpl = async () => {
      await gate
      return { token: renewedToken, expiresAt: live(3600) }
    }

    const recovery = persistenceModule.recoverSession(email, { email }, 'upstream_session_unauthorized')
    // While it ran, a concurrent login published a newer session.
    const loginToken = tokenWith(live(5400))
    await persistenceModule.publishSession(email, { token: loginToken, expiresAt: live(5400), jar: jarWith('login=1') })
    releaseRenew()
    assert.equal(await recovery, null, 'the caller is not handed a token the store no longer holds')
    assert.ok(store.sessionFor(email, loginToken), 'the concurrent login session wins')
    assert.equal(store.sessionFor(email, renewedToken), null)
  })
})

test('a failed recovery leaves the refused session exactly where it was', async () => {
  await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
    const email = 'kept@example.invalid'
    const token = tokenWith(live(1800))
    await persistenceModule.publishSession(email, { token, expiresAt: live(1800), jar: jarWith('kept=1') })
    const session = store.sessions.get(email)
    renewImpl = async () => { throw new Error('signin-worker down') }

    assert.equal(await persistenceModule.recoverSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized'), null)
    assert.equal(store.sessions.get(email), session)
    assert.equal((await readSessionsFile()).sessions[email].token, token, 'still on disk too: a restart finds it and recovers again')
    // Inside the interval of that recovery nothing else is attempted.
    assert.equal(await persistenceModule.recoverSession(email, { email, password: 'pw' }, 'upstream_session_unauthorized'), null)
    assert.deepEqual(workerCalls.renew, [email])
  })
})

test('jar sync writes the session through, and only when the jar changed', async () => {
  await withBrowserFile(async ({ persistenceModule, store, readSessionsFile }) => {
    const email = 'sync@example.invalid'
    const token = tokenWith(live(1800))
    // The session's jar is the browser's own, as the worker handed it over.
    await persistenceModule.publishSession(email, {
      token, expiresAt: live(1800), jar: store.jarFromCookies([browserCookie('cna', 'old')])
    })
    // The write-through is not awaited by the caller. The test waits for it by
    // its promise: reading the file while it is being replaced is what makes
    // the replace fail on Windows (EPERM on rename).
    const writes = []
    const save = persistenceModule.persistence.saveV2Session.bind(persistenceModule.persistence)
    persistenceModule.persistence.saveV2Session = (...args) => {
      const write = save(...args)
      writes.push(write)
      return write
    }
    const storedCookies = async () => (await readSessionsFile()).sessions[email].jar.cookies
    const browserJar = [browserCookie('cna', 'new'), browserCookie('ssxmod_itna', 'rotated')]

    assert.equal(persistenceModule.syncCookies(email, browserJar), true)
    assert.equal(writes.length, 1)
    assert.equal(await writes[0], true)
    assert.deepEqual((await storedCookies()).map(cookie => cookie.key).sort(), ['cna', 'ssxmod_itna'])
    // The app's own calls feed the same jar.
    assert.equal(persistenceModule.readSetCookies(email, { 'set-cookie': ['isg=1; Path=/'] }, 'https://chat.qwen.ai/x'), true)
    assert.equal(await writes[1], true)
    assert.deepEqual((await storedCookies()).map(cookie => cookie.key).sort(), ['cna', 'isg', 'ssxmod_itna'])
    // Nothing new: nothing written.
    assert.equal(persistenceModule.syncCookies(email, browserJar), false)
    assert.equal(persistenceModule.readSetCookies(email, { 'set-cookie': ['isg=1; Path=/'] }, 'https://chat.qwen.ai/x'), false)
    assert.equal(persistenceModule.readSetCookies(email, {}, 'https://chat.qwen.ai/x'), false)
    // An account without a session has no jar to feed.
    assert.equal(persistenceModule.syncCookies('ghost@example.invalid', browserJar), false)
    assert.equal(persistenceModule.readSetCookies('ghost@example.invalid', { 'set-cookie': 'isg=1' }, 'https://chat.qwen.ai/x'), false)
    assert.equal(writes.length, 2)
    // The sync rewrites the jar only.
    assert.equal(store.sessions.get(email).token, token)
  })
})

test('sessionToken is the token the store holds for the account — the one prepareChat accepts', async () => {
  await withBrowserFile(async ({ persistenceModule }) => {
    const email = 'rotated@example.invalid'
    const before = tokenWith(live(1800))
    const after = tokenWith(live(3600))
    assert.equal(persistenceModule.sessionToken({ email }, before), before, 'no session: the request keeps its token')
    await persistenceModule.publishSession(email, { token: after, expiresAt: live(3600), jar: jarWith() })
    assert.equal(persistenceModule.sessionToken({ email }, before), after)
    assert.equal(persistenceModule.sessionToken({ email: 'other@example.invalid' }, before), before)
  })
})
