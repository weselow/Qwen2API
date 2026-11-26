const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

// The timer's cycle of token refreshes (Qwen2API-ops). In browser mode one
// refresh is a reload of the account's page in the signin-worker, and the
// cycle took the accounts one after another, a second apart: a burst of page
// loads from one address whenever several fell due together — accounts added
// on one day do, their tokens run out on one day. On a fake clock, here: the
// second account is not refreshed before the pause that follows the first;
// one cycle at a time; an account removed or renewed meanwhile is left alone.
// Browser mode, as on prod; the refreshes themselves are stubs.
process.env.API_KEY = 'auto-refresh-pacing-test'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const v2sessions = require('../src/utils/v2-session-store')
const { logger } = require('../src/utils/logger')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

const HOUR = 3600
const MONTH = 30 * 24 * HOUR
const token = secondsFromNow =>
    `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url')}.signature`
const renewed = account => ({ ...account, token: token(MONTH), expires: Math.floor(Date.now() / 1000) + MONTH })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Let what has been started run on until it has to wait for the clock.
const settle = async () => {
    for (let turn = 0; turn < 25; turn++) await new Promise(resolve => setImmediate(resolve))
}

/**
 * `pending`, or a failure after `ms` of REAL time — the clock of the test is
 * fake and may never be turned; this guard keeps a broken cycle from hanging
 * the file (setInterval is not among the faked clocks).
 */
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setInterval(() => {
        clearInterval(guard)
        reject(new Error(`${what} did not happen in ${ms} ms of real time`))
    }, ms)
    Promise.resolve(pending).then(value => { clearInterval(guard); resolve(value) }, error => { clearInterval(guard); reject(error) })
})

/**
 * Turn the clock until `pending` is over: a cycle that waits for the clock
 * cannot hang a test — it fails here instead, after `limit` turns.
 */
async function untilDone(clock, pending, stepMs = 1000, limit = 300) {
    let done = false
    const watched = Promise.resolve(pending).then(value => { done = true; return value })
    for (let turn = 0; !done && turn < limit; turn++) {
        await settle()
        if (!done) clock.tick(stepMs)
    }
    if (!done) throw new Error(`the cycle did not end in ${limit} turns of ${stepMs} ms of the clock`)
    return watched
}

// What the account manager says while a test runs.
function capture(t) {
    const lines = { info: [], warn: [], error: [] }
    const saved = { info: logger.info, warn: logger.warn, error: logger.error }
    logger.info = message => lines.info.push(String(message))
    logger.warn = message => lines.warn.push(String(message))
    logger.error = message => lines.error.push(String(message))
    t.after(() => Object.assign(logger, saved))
    return lines
}

/**
 * Accounts whose tokens run out within the hour — what a cycle finds. Every
 * refresh is recorded with the time (of the clock under test) it began, and
 * answered as the test says.
 */
async function withDueAccounts(t, names, fn) {
    const original = accountManager.accountTokens
    const emails = names.map(name => `${name}@example.invalid`)
    const accounts = emails.map(email => ({ email, password: 'synthetic', token: token(HOUR), expires: Math.floor(Date.now() / 1000) + HOUR }))
    accountManager.accountTokens = accounts
    accountManager.accountRotator.setAccounts(accounts)
    const starts = []
    let answer = async account => renewed(account)
    t.mock.method(accountManager.tokenManager, 'refreshToken', async account => {
        starts.push({ email: account.email, at: Date.now() })
        return answer(account)
    })
    t.mock.method(accountManager.dataPersistence, 'saveAccount', async () => true)
    const running = accountManager.autoRefreshCycleRunning
    try {
        await fn({ emails, accounts, starts, answerWith: reply => { answer = reply } })
    } finally {
        accountManager.accountTokens = original
        accountManager.accountRotator.setAccounts(original)
        // A cycle that a failed test left waiting for a clock that is gone would keep the flag for good.
        accountManager.autoRefreshCycleRunning = running
    }
}

const onFakeClock = t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    return t.mock.timers
}

test('two accounts due in one tick: the second is refreshed only after the pause that follows the first', async t => {
    const clock = onFakeClock(t)
    // The pause is exactly its minimum.
    t.mock.method(Math, 'random', () => 0)
    await withDueAccounts(t, ['a', 'b', 'c'], async ({ emails, starts }) => {
        let done = null
        const cycle = accountManager.autoRefreshTokens(24, { paced: true }).then(count => { done = count; return count })
        t.after(() => within(cycle, 2000, 'the cycle').catch(() => {}))
        await settle()
        assert.deepEqual(starts.map(start => start.email), [emails[0]])
        assert.equal(done, null)

        // A millisecond short of the pause: still the first only.
        clock.tick(29999)
        await settle()
        assert.equal(starts.length, 1)
        clock.tick(1)
        await settle()
        assert.deepEqual(starts.map(start => start.email), [emails[0], emails[1]])
        assert.equal(starts[1].at - starts[0].at, 30000, 'the second began one pause after the first')

        clock.tick(30000)
        await settle()
        assert.deepEqual(starts.map(start => start.email), emails)
        assert.equal(starts[2].at - starts[1].at, 30000)
        // Nothing follows the last account, so the cycle is over without another turn of the clock.
        assert.equal(done, 3)
        assert.equal(await cycle, 3)
    })
})

test('the pause carries its jitter: with the dice at half it is one and a half intervals', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0.5)
    await withDueAccounts(t, ['a', 'b'], async ({ starts }) => {
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await settle()
        clock.tick(44999)
        await settle()
        assert.equal(starts.length, 1)
        clock.tick(1)
        await settle()
        assert.equal(starts.length, 2)
        assert.equal(await cycle, 2)
    })
})

test('the pause is never shorter than its minimum, nor more than twice it', () => {
    assert.equal(accountManager._refreshPauseMs(() => 0), 30000)
    assert.equal(accountManager._refreshPauseMs(() => 0.5), 45000)
    // Rounded to a millisecond, the top of the jitter is the double exactly.
    assert.ok(accountManager._refreshPauseMs(() => 0.999999) <= 60000)
})

test('a tick that finds the timer’s cycle still running stands back — no second cycle beside it', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    const lines = capture(t)
    await withDueAccounts(t, ['a', 'b'], async ({ emails, starts, answerWith }) => {
        const entered = deferred()
        const released = deferred()
        let hold = true
        answerWith(async account => {
            if (hold) { hold = false; entered.resolve(); await released.promise }
            return renewed(account)
        })
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await within(entered.promise, 5000, 'the first refresh')
        assert.equal(accountManager.autoRefreshCycleRunning, true)

        // The timer fires again meanwhile: its new cycle stands back, at once.
        assert.equal(await within(accountManager.autoRefreshTokens(24, { paced: true }), 5000, 'the second tick'), 0)
        assert.deepEqual(starts.map(start => start.email), [emails[0]])
        assert.equal(lines.info.filter(line => line.includes('跳过这一轮')).length, 1)

        released.resolve()
        await settle()
        clock.tick(30000)
        await settle()
        // Each account once, by the one cycle.
        assert.deepEqual(starts.map(start => start.email), emails)
        assert.equal(await cycle, 2)
        assert.equal(accountManager.autoRefreshCycleRunning, false, 'what is over is over')
    })
})

test('the dashboard’s buttons are not the timer: their cycle keeps its one-second spacing and is not turned away', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    await withDueAccounts(t, ['a', 'b'], async ({ starts, answerWith }) => {
        // Alone first: POST /refreshAllAccounts calls the cycle without the option.
        assert.equal(await untilDone(clock, accountManager.autoRefreshTokens(24)), 2)
        assert.deepEqual(starts.map(start => start.at - starts[0].at), [0, 1000])
    })
    await withDueAccounts(t, ['c', 'd'], async ({ emails, starts, answerWith }) => {
        // Beside a cycle of the timer that is still at work.
        const entered = deferred()
        const released = deferred()
        let hold = true
        answerWith(async account => {
            if (hold) { hold = false; entered.resolve(); await released.promise }
            return renewed(account)
        })
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await within(entered.promise, 5000, 'the first refresh')
        let done = null
        const buttons = within(accountManager.autoRefreshTokens(8760)).then(count => { done = count; return count })
        await settle()
        assert.equal(done, null, 'it runs its own cycle; it is not skipped, as a tick would be')
        released.resolve()
        await settle()
        clock.tick(1000)
        await settle()
        clock.tick(30000)
        await settle()
        assert.deepEqual([await buttons, await cycle], [2, 1])
        assert.deepEqual([...new Set(starts.map(start => start.email))].sort(), [...emails].sort())
    })
})

test('an account removed while the cycle waits is not refreshed — that would open its page in the worker again', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    await withDueAccounts(t, ['a', 'b'], async ({ emails, starts, accounts }) => {
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await settle()
        // Removed from the app meanwhile, as removeAccount does it.
        accountManager.accountTokens = [accounts[0]]
        clock.tick(30000)
        await settle()
        assert.deepEqual(starts.map(start => start.email), [emails[0]])
        assert.equal(await cycle, 1)
    })
})

test('an account whose token was renewed meanwhile is left to it', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    const lines = capture(t)
    await withDueAccounts(t, ['a', 'b'], async ({ emails, starts, accounts }) => {
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await settle()
        accountManager.accountTokens = [accounts[0], renewed(accounts[1])]
        clock.tick(30000)
        await settle()
        assert.deepEqual(starts.map(start => start.email), [emails[0]])
        assert.equal(await cycle, 1)
        assert.equal(lines.info.filter(line => line.includes('令牌已是新的')).length, 1)
    })
})

test('a refresh that failed paces the next account all the same — the attempt was a page load too', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    await withDueAccounts(t, ['a', 'b'], async ({ starts, answerWith }) => {
        answerWith(async () => null)
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await settle()
        assert.equal(starts.length, 1)
        clock.tick(29999)
        await settle()
        assert.equal(starts.length, 1)
        clock.tick(1)
        await settle()
        assert.equal(starts.length, 2)
        assert.equal(await cycle, 0)
    })
})

test('outside browser mode the timer’s cycle keeps its one-second spacing: a refresh there is no page load', async t => {
    const clock = onFakeClock(t)
    t.mock.method(Math, 'random', () => 0)
    v2sessions.browser = false
    t.after(() => { v2sessions.browser = true })
    await withDueAccounts(t, ['a', 'b'], async ({ starts }) => {
        const cycle = within(accountManager.autoRefreshTokens(24, { paced: true }))
        await settle()
        assert.equal(starts.length, 1)
        clock.tick(1000)
        await settle()
        assert.deepEqual(starts.map(start => start.at - starts[0].at), [0, 1000])
        // As before the change, the one-second wait follows the last account too.
        assert.equal(await untilDone(clock, cycle), 2)
    })
})

test('the timer itself asks for the paced cycle', () => {
    const source = fs.readFileSync(require.resolve('../src/utils/account'), 'utf8')
    assert.match(source, /\(\) => this\.autoRefreshTokens\(24, \{ paced: true \}\)/)
})
