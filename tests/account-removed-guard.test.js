const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

// A request that was still running on an account when the operator removed
// it (Qwen2API-u50). It keeps that account's object, and its retry, or its
// session's recovery, used to ask the signin-worker for the account again:
// the worker opened its page and cached a session for an account that was
// gone — and, with the profile deleted on removal, the app went on to sign
// the account in by password. The worker cannot tell such a call from one for
// an account just added; the app can, because it is the one that removed it.
// Browser mode, as on prod; the worker is a stand-in on loopback that writes
// down every request it is asked, and can hold one until the test lets it go.
process.env.API_KEY = 'account-removed-guard-test'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''
// The recovery's waits are read from the environment: a value set outside would move them.
delete process.env.V2_SESSION_RELOGIN_MIN_INTERVAL_MS
delete process.env.V2_SESSION_RECOVERY_MIN_INTERVAL_MS

const config = require('../src/config')
const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const sessionPersistence = require('../src/utils/v2-session-persistence')
const signinWorker = require('../src/utils/signin-worker-client')
const registry = require('../src/utils/account-registry')
const browserEgress = require('../src/utils/browser-egress')
const { isRetryableNetworkError } = require('../src/utils/request')
const { ChatCreationError } = require('../src/utils/upstream-error')
const { logger } = require('../src/utils/logger')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const HOUR = 3600
const CHAT = 'https://chat.qwen.ai'
const exp = () => Math.floor(Date.now() / 1000) + HOUR
const token = () => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: exp() })).toString('base64url')}.signature`
const TOKEN = token()

// `pending`, or a failure after `ms`: nothing a test waits for may keep it for ever.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
    Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

// What `pending` ended with — its value or its error — or a failure after `ms`: a request
// that never ends fails the test instead of hanging it.
const outcomeOf = async (pending, ms = 5000, what = 'it') => within(
    Promise.resolve(pending).then(value => ({ value }), error => ({ error })), ms, `${what} did not end in ${ms} ms`)

async function until(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!(await Promise.resolve().then(condition).catch(() => false))) {
        if (Date.now() > deadline) throw new Error('condition not met in time')
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

// The worker's JSON answers and their helpers, as the app reads them.
const jsonTo = (res, status, payload) => {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
}
const session = () => ({ token: TOKEN, expiresAt: exp(), cookies: [] })
const NO_PROFILE = { code: 'no_profile', message: 'No persisted profile for this account.' }
const RELAY_END = `${JSON.stringify({ type: 'end', cookies: [] })}\n`

/**
 * The worker as far as these tests are concerned: it answers every route the
 * app knows, and writes down each request. `mode` stages what is held or
 * refused; what is held is answered by the test, as the real worker would
 * have answered it by then.
 */
async function standIn(t) {
    const requests = []
    const held = { renew: [], egress: [], stream: [], session: [] }
    const mode = { holdRenew: false, holdEgress: false, holdStream: false, holdSession: false, refuseSession: false }
    // The worker's streaming /egress: a head and the end, as the app reads them.
    const relay = (res, url, status = 200) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(`${JSON.stringify({ type: 'head', status, url, redirected: false, headers: {}, cookies: [] })}\n${RELAY_END}`)
    }
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null
            requests.push({ url: req.url, body })
            if (req.url === '/renew') return mode.holdRenew ? held.renew.push(res) : jsonTo(res, 200, session())
            if (req.url === '/session') {
                if (mode.holdSession) return held.session.push(res)
                if (mode.refuseSession) return jsonTo(res, 500, { code: 'browser_error', message: 'boom' })
                return jsonTo(res, 200, session())
            }
            if (req.url === '/forget') return jsonTo(res, 200, { ok: true, session: true, page: true, profile: 'kept' })
            if (req.url === '/egress' && body?.stream === true) {
                if (mode.holdStream) return held.stream.push(res)
                return relay(res, body.url)
            }
            if (req.url === '/egress') {
                if (mode.holdEgress) return held.egress.push(res)
                return jsonTo(res, 200, { status: 200, headers: {}, body: '{"success":true}', url: body.url, redirected: false, cookies: [] })
            }
            jsonTo(res, 500, { code: 'browser_error', message: 'Not this test’s subject.' })
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const saved = { signinWorkerUrl: config.signinWorkerUrl }
    config.signinWorkerUrl = `http://127.0.0.1:${server.address().port}`
    t.after(async () => {
        config.signinWorkerUrl = saved.signinWorkerUrl
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    })
    return { requests, held, mode, relay, routes: () => requests.map(request => request.url) }
}

let sequence = 0

/** An account the app holds, replaced after the test by whatever it held before. */
async function withAccount(t, fn) {
    const original = accountManager.accountTokens
    const email = `held-${++sequence}@example.invalid`
    const account = { email, password: 'synthetic', token: TOKEN, expires: exp() }
    // Added again, as _addAccountWithToken has it once its record is saved: in the manager's records, and no longer removed.
    const addedAgain = () => {
        accountManager.accountTokens = [account]
        accountManager.accountRotator.setAccounts([account])
        registry.noteAdded(email)
    }
    t.after(() => {
        accountManager.accountTokens = original
        accountManager.accountRotator.setAccounts(original)
        registry.removedAccounts.clear()
    })
    addedAgain()
    await fn({ email, account, addedAgain })
}

// The roads a request of an account can take to the worker.
const roads = {
    renew: account => signinWorker.renewSession(account.email, account, { force: true }),
    call: account => signinWorker.egress(account.email, account, { url: `${CHAT}/api/v2/chats/new`, body: '{}' }),
    stream: async account => {
        const relay = await signinWorker.egressStream(account.email, account, {
            url: `${CHAT}/api/v2/chat/completions?chat_id=1`, body: '{}'
        })
        while (!(await relay.frames.next()).done) { /* read to its end */ }
    }
}
const ROADS = Object.keys(roads)
const chatsNew = account => ({ account, url: `${CHAT}/api/v2/chats/new`, body: {} })
const COMPLETIONS = { url: `${CHAT}/api/v2/chat/completions?chat_id=1`, body: '{}', timeoutMs: 60000 }
const sessionOf = () => ({ token: TOKEN, expiresAt: exp(), jar: null })

test('while the app holds the account, every road to the worker is open', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ account }) => {
        for (const road of ROADS) await roads[road](account)
        assert.deepEqual(worker.routes(), ['/renew', '/egress', '/egress'])
    })
})

test('an account the manager never held is not taken for a removed one: removal is known, not guessed', async t => {
    const worker = await standIn(t)
    const account = { email: 'never-held@example.invalid', password: 'synthetic' }
    for (const road of ROADS) await roads[road](account)
    assert.deepEqual(worker.routes(), ['/renew', '/egress', '/egress'])
})

test('once the app has removed the account, none of its calls reaches the worker — and what they end with is neither a lost session nor a failure a retry mends', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        assert.deepEqual(worker.routes(), ['/forget'])
        for (const road of ROADS) {
            await assert.rejects(roads[road](account), error => {
                assert.equal(error.code, registry.ACCOUNT_REMOVED)
                assert.equal(error.status, 409)
                // Not a lost session: no password sign-in follows it.
                assert.equal(error.sessionLost, undefined)
                // Nobody's fault, and no HTTP answer to classify as a network failure.
                assert.equal(error.notAccountFault, true)
                assert.equal(error.response, undefined)
                assert.equal(isRetryableNetworkError(error), false, `${road}: the request's retry loop would retry it`)
                return true
            }, `${road} of a removed account`)
        }
        assert.deepEqual(worker.routes(), ['/forget'], 'nothing but the /forget of the removal itself')
    })
})

test('added again — its record saved for good — the account’s calls reach the worker once more; a re-add that is not saved leaves it removed', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account, addedAgain }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        // The manager's records hold it for a moment, but its record was not saved: a re-add on its way to roll back.
        accountManager.accountTokens = [account]
        await assert.rejects(roads.renew(account), { code: registry.ACCOUNT_REMOVED })
        // With no storage there is no record to save: the re-add fails, as a failing save does.
        assert.equal(await accountManager.addAccountWithToken(email, account.password, account.token, account.expires), false)
        await assert.rejects(roads.renew(account), { code: registry.ACCOUNT_REMOVED })
        assert.deepEqual(worker.routes(), ['/forget'])

        addedAgain()
        await roads.renew(account)
        assert.deepEqual(worker.routes(), ['/forget', '/renew'])
    })
})

test('an account whose record the manager saves again is the app’s again — by the manager’s own adding', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        await assert.rejects(roads.renew(account), { code: registry.ACCOUNT_REMOVED })
        // Storage accepts the record: the adding succeeds, and from there on the account's calls go out.
        t.mock.method(accountManager.dataPersistence, 'saveAccount', async () => true)
        assert.equal(await accountManager.addAccountWithToken(email, account.password, account.token, account.expires), true)
        await roads.renew(account)
        assert.deepEqual(worker.routes(), ['/forget', '/renew'])
    })
})

test('the session’s recovery of a removed account asks the worker for nothing — and says nothing', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        assert.equal(await within(sessionPersistence.recoverSession(email, account, 'v2_session_required')), null)
        assert.equal(await within(sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized')), null)
        assert.deepEqual(worker.routes(), ['/forget'])
        assert.deepEqual(lines.error, [])
        assert.equal(lines.warn.filter(line => line.includes(email)).length, 0)
    })
})

test('a renewal that was out when the account was removed, and comes back with a lost profile, ends in no password sign-in', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account }) => {
        worker.mode.holdRenew = true
        const recovery = sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized')
        await until(() => worker.held.renew.length === 1)
        worker.mode.holdRenew = false

        assert.equal(await accountManager.removeAccount(email), true)
        // The worker, having closed the page — or deleted the profile — answers as it answers a dead profile.
        jsonTo(worker.held.renew[0], 404, NO_PROFILE)

        assert.deepEqual(await outcomeOf(recovery, 5000, 'the recovery'), { value: null })
        assert.deepEqual(worker.routes(), ['/renew', '/forget'], 'no sign-in was asked for the account that is gone')
        assert.equal(v2sessions.sessions.has(email), false)
        assert.deepEqual(lines.error, [])
    })
})

test('nor a password sign-in for an account whose session had been refused twice before it was removed — and nothing of the recovery is kept that an account added again would inherit', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account, addedAgain }) => {
        // Before the removal: a session refused twice, and a sign-in that failed — its wait now doubles.
        v2sessions.setSession(email, sessionOf())
        worker.mode.refuseSession = true
        sessionPersistence.escalateToRelogin(email, account, 'upstream_session_unauthorized')
        await within(sessionPersistence.renewals.get(email), 5000, 'the sign-in the escalation starts')
        assert.deepEqual(worker.routes(), ['/session'])
        // What the account's state costs it while the app still holds it: the next recovery waits, and asks for nothing.
        assert.equal(await sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), null)
        assert.deepEqual(worker.routes(), ['/session'])

        // Removed: a request still out on it escalates once more, and recovers — to nothing, and without a sign-in.
        assert.equal(await accountManager.removeAccount(email), true)
        sessionPersistence.escalateToRelogin(email, account, 'upstream_session_unauthorized')
        assert.equal(await sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), null)
        assert.deepEqual(worker.routes(), ['/session', '/forget'])
        assert.equal(v2sessions.sessions.has(email), false, 'the session of the removed account is not in the store')
        // The sign-in that failed before the removal was a failure, and was said; after the removal nothing is.
        assert.equal(lines.error.length, 1, lines.error.join('\n'))

        // A session that is in the store meanwhile is a re-add's, published before its record: neither dropped nor renewed.
        v2sessions.setSession(email, sessionOf())
        sessionPersistence.invalidateSession(email, account, 'upstream_session_unauthorized')
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(v2sessions.sessions.has(email), true)
        assert.equal(sessionPersistence.renewals.has(email), false)
        assert.deepEqual(worker.routes(), ['/session', '/forget'])
        v2sessions.deleteSession(email)

        // Added again: its first recovery is what a fresh account's is — a reload, at once.
        addedAgain()
        const recovered = await within(sessionPersistence.recoverSession(email, account, 'upstream_session_unauthorized'), 5000, 'the recovery after a re-add')
        assert.equal(recovered?.token, TOKEN)
        assert.deepEqual(worker.routes(), ['/session', '/forget', '/renew'])
    })
})

test('a renewal that was out when the account was removed publishes nothing when it ends', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account, addedAgain }) => {
        worker.mode.holdRenew = true
        const recovery = sessionPersistence.recoverSession(email, account, 'v2_session_required')
        await until(() => worker.held.renew.length === 1)

        assert.equal(await accountManager.removeAccount(email), true)
        assert.equal(v2sessions.sessions.has(email), false)

        // The worker answers the renewal of the account that is gone.
        jsonTo(worker.held.renew[0], 200, session())

        assert.equal(await within(recovery, 5000, 'the renewal ending'), null)
        assert.equal(v2sessions.sessions.has(email), false, 'no session of the removed account is put back')
        assert.equal(sessionPersistence.renewals.has(email), false)
        assert.deepEqual(lines.error, [])

        // Nor is the moment of its end remembered for an account added again: nothing throttles its first recovery.
        worker.mode.holdRenew = false
        addedAgain()
        const recovered = await within(sessionPersistence.recoverSession(email, account, 'v2_session_required'), 5000, 'the recovery after a re-add')
        assert.equal(recovered?.token, TOKEN)
        assert.deepEqual(worker.routes(), ['/renew', '/forget', '/renew'])
    })
})

test('a sign-in that fails after its account was removed is not counted against the account added again', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    // The recovery keeps its own clock, so that its waits can be gone past without sleeping.
    sessionPersistence.resetRecoveryForTests()
    let now = Date.now()
    sessionPersistence.setRecoveryClockForTests(() => now)
    t.after(() => {
        sessionPersistence.setRecoveryClockForTests(null)
        sessionPersistence.resetRecoveryForTests()
    })
    const signIns = () => worker.routes().filter(route => route === '/session').length
    await withAccount(t, async ({ email, account, addedAgain }) => {
        // Its session refused twice: a sign-in starts, and is out when the account is removed — then fails.
        worker.mode.holdSession = true
        sessionPersistence.escalateToRelogin(email, account, 'upstream_session_unauthorized')
        await until(() => worker.held.session.length === 1)
        worker.mode.holdSession = false
        assert.equal(await accountManager.removeAccount(email), true)
        jsonTo(worker.held.session[0], 500, { code: 'browser_error', message: 'boom' })
        await within(sessionPersistence.renewals.get(email), 5000, 'the sign-in ending')
        // The failure of an account that is gone is no failure of any session: nothing is said of it.
        assert.deepEqual(lines.error, [])

        // Added again. One sign-in is tried, and fails: the first failure of this account.
        addedAgain()
        worker.mode.holdSession = false
        worker.mode.refuseSession = true
        sessionPersistence.escalateToRelogin(email, account, 'upstream_session_unauthorized')
        await within(sessionPersistence.renewals.get(email), 5000, 'the sign-in after the re-add')
        assert.equal(signIns(), 2)

        // One failure doubles the base minute. Two and a half minutes on, a sign-in is allowed again —
        // had the old one's failure been counted too, the wait would be four minutes.
        now += 150 * 1000
        sessionPersistence.escalateToRelogin(email, account, 'upstream_session_unauthorized')
        await within(sessionPersistence.renewals.get(email), 5000, 'the sign-in two and a half minutes on')
        assert.equal(signIns(), 3)
    })
})

// What a request of a removed account ends as: one that did not get through — a 503 the client may retry.
const didNotGetThrough = error => {
    assert.ok(error instanceof ChatCreationError, `the category the direct path throws, not ${error?.name}`)
    assert.equal(error.code, 'upstream_transport_error')
    assert.equal(error.status, 503)
    return true
}

test('chats/new for a removed account ends before the worker — as a request that did not get through, said once as what it is', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account }) => {
        v2sessions.setSession(email, sessionOf())
        assert.equal(await accountManager.removeAccount(email), true)
        assert.equal(v2sessions.sessions.has(email), false, 'the session of the removed account is gone from the store')
        await assert.rejects(browserEgress.createChat(chatsNew(account)), didNotGetThrough)
        assert.deepEqual(worker.routes(), ['/forget'])
        assert.deepEqual(lines.error, [])
        assert.equal(lines.warn.filter(line => line.includes('was removed from the app') && line.includes(email)).length, 1)
    })
})

test('a chats/new that was out when the account was removed, and comes back with a lost profile, ends the same way', async t => {
    const worker = await standIn(t)
    const lines = capture(t)
    await withAccount(t, async ({ email, account }) => {
        v2sessions.setSession(email, sessionOf())
        worker.mode.holdEgress = true
        const creating = browserEgress.createChat(chatsNew(account))
        creating.catch(() => {})
        await until(() => worker.held.egress.length === 1)
        worker.mode.holdEgress = false

        assert.equal(await accountManager.removeAccount(email), true)
        jsonTo(worker.held.egress[0], 404, NO_PROFILE)

        const { error } = await outcomeOf(creating, 5000, 'the chats/new request')
        assert.ok(error, 'the chats/new request resolved')
        didNotGetThrough(error)
        assert.deepEqual(worker.routes(), ['/egress', '/forget'], 'no renewal and no sign-in for the account that is gone')
        assert.deepEqual(lines.error, [])
    })
})

test('a whole-answer call that was out when the account was removed, and comes back with a lost profile, is a call that did not get through', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        worker.mode.holdEgress = true
        const asking = browserEgress.egressJson({ account, url: `${CHAT}/api/v1/tasks/status/task-1` })
        asking.catch(() => {})
        await until(() => worker.held.egress.length === 1)
        worker.mode.holdEgress = false

        assert.equal(await accountManager.removeAccount(email), true)
        jsonTo(worker.held.egress[0], 404, NO_PROFILE)

        const { error } = await outcomeOf(asking, 5000, 'the whole-answer call')
        assert.ok(error, 'the whole-answer call resolved')
        didNotGetThrough(error)
        assert.deepEqual(worker.routes(), ['/egress', '/forget'])
    })
})

test('a completions relay for a removed account is refused where its retry would start — as nobody’s fault, so that nothing retries it', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        assert.equal(await accountManager.removeAccount(email), true)
        await assert.rejects(browserEgress.postCompletions({ ...COMPLETIONS, account }), error => {
            assert.equal(error.code, registry.ACCOUNT_REMOVED)
            assert.equal(error.notAccountFault, true)
            assert.equal(error.response, undefined)
            assert.equal(isRetryableNetworkError(error), false)
            return true
        })
        // One attempt, and no recovery: the worker was asked for nothing.
        assert.deepEqual(worker.routes(), ['/forget'])
    })
})

test('a completions relay that was out when the account was removed, and answers a refused session, ends in the refusal of the retry — and in no renewal', async t => {
    const worker = await standIn(t)
    await withAccount(t, async ({ email, account }) => {
        worker.mode.holdStream = true
        const streaming = browserEgress.postCompletions({ ...COMPLETIONS, account })
        streaming.catch(() => {})
        await until(() => worker.held.stream.length === 1)
        worker.mode.holdStream = false

        assert.equal(await accountManager.removeAccount(email), true)
        worker.relay(worker.held.stream[0], COMPLETIONS.url, 401)

        // A refused session before the first frame is what the request's retry loop mends: so this
        // one is a failure the retry mends — and the refusal waits on the retry — not the 401 of a
        // session that is gone.
        const { error } = await outcomeOf(streaming, 5000, 'the completions request')
        assert.ok(error, 'the completions request resolved')
        assert.equal(error.workerCode, 'account_removed')
        assert.equal(isRetryableNetworkError(error), true)
        assert.deepEqual(worker.routes(), ['/egress', '/forget'], 'no renewal and no sign-in for the account that is gone')
    })
})
