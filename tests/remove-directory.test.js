const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

// How the smokes take their temporary directory away without a cleanup race
// failing the run (Qwen2API-3ue.13).
//
// The refusal itself is Windows' alone, and it is not made to order: a process
// started in the directory makes Windows keep it in most runs and in none in
// the others (measured 2026-11-26), and nothing Node or Bun opens keeps it. So
// the retries are driven here with a `remove` and a `sleep` of the test's own,
// and the real thing on Windows is a probe run by hand (NOTES Qwen2API-3ue.13).
const { removeDirectory, discardTemporaryDirectory } = require('../tools/remove-directory')

const busy = code => Object.assign(new Error(`${code}: resource busy or locked, rm 'somewhere'`), { code })

// A `remove` that fails with the given codes, in order, and then does its work.
const flaky = (...codes) => {
    const calls = []
    const remove = async (directory, options) => {
        calls.push({ directory, options })
        const code = codes.shift()
        if (code) throw busy(code)
    }
    return { remove, calls }
}
const recorder = () => {
    const pauses = []
    const sleep = async ms => { pauses.push(ms) }
    return { sleep, pauses }
}
const exists = async directory => Boolean(await stat(directory).catch(() => null))
const warned = async run => {
    const warnings = []
    const warn = console.warn
    console.warn = message => { warnings.push(message) }
    try {
        return { outcome: await run(), warnings }
    } finally {
        console.warn = warn
    }
}

test('a directory that goes at once is removed on the first try, with force and recursion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qwen-remove-directory-'))
    await mkdir(path.join(directory, 'data'))
    await writeFile(path.join(directory, 'data/data.json'), '{}')
    const { sleep, pauses } = recorder()
    const outcome = await removeDirectory(directory, { sleep })
    assert.deepEqual(outcome, { removed: true, attempts: 1 })
    assert.deepEqual(pauses, [])
    assert.equal(await exists(directory), false)
})

test('a directory that is busy is asked for again, with a growing pause, until it goes', async () => {
    const { remove, calls } = flaky('EBUSY', 'ENOTEMPTY', 'EBUSY')
    const { sleep, pauses } = recorder()
    const outcome = await removeDirectory('/temporary/one', { remove, sleep })
    assert.deepEqual(outcome, { removed: true, attempts: 4 })
    assert.deepEqual(pauses, [100, 200, 300], 'the pause before the nth retry is n × 100 ms')
    assert.equal(calls.length, 4)
    assert.ok(calls.every(call => call.directory === '/temporary/one' &&
        call.options.recursive === true && call.options.force === true),
        'each try is a forced recursive removal of that directory')
})

test('EBUSY, EPERM and ENOTEMPTY are each waited out; any other failure is handed back at once', async () => {
    for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
        const { sleep, pauses } = recorder()
        const outcome = await removeDirectory('/temporary/one', { remove: flaky(code).remove, sleep })
        assert.deepEqual({ removed: outcome.removed, attempts: outcome.attempts, error: outcome.error }, { removed: true, attempts: 2, error: undefined }, code)
        assert.deepEqual(pauses, [100], code)
    }
    const { sleep, pauses } = recorder()
    const outcome = await removeDirectory('/temporary/one', { remove: flaky('EIO').remove, sleep })
    assert.equal(outcome.removed, false)
    assert.equal(outcome.attempts, 1, 'nothing is waited out that is not a lock')
    assert.equal(outcome.error.code, 'EIO')
    assert.deepEqual(pauses, [])
})

test('a directory that stays busy is given up: told of, not thrown', async () => {
    const { remove, calls } = flaky('EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY')
    const { sleep, pauses } = recorder()
    const outcome = await removeDirectory('/temporary/one', { attempts: 4, remove, sleep })
    assert.equal(outcome.removed, false)
    assert.equal(outcome.attempts, 4, 'the last try is the fourth')
    assert.equal(outcome.error.code, 'EBUSY')
    assert.deepEqual(pauses, [100, 200, 300], 'no pause after the last try')
    assert.equal(calls.length, 4)
})

test('a directory that stays busy is given up after ten tries and under five seconds, the default', async () => {
    const { remove, calls } = flaky(...Array(20).fill('EPERM'))
    const { sleep, pauses } = recorder()
    const outcome = await removeDirectory('/temporary/one', { remove, sleep })
    assert.equal(outcome.removed, false)
    assert.equal(outcome.attempts, 10)
    assert.equal(calls.length, 10)
    assert.equal(pauses.length, 9)
    // 100 + 200 + … + 900 ms.
    assert.equal(pauses.reduce((sum, pause) => sum + pause, 0), 4500)
})

test('a smoke is told what it leaves — how often it asked, why, what is in the directory, and where — and is not failed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qwen-remove-directory-left-'))
    await mkdir(path.join(directory, 'logs'))
    await writeFile(path.join(directory, 'logs/app.log'), 'x')
    // A removal that clears the directory but never gets the directory itself: what Bun does on Windows.
    const stubborn = async (target, options) => {
        for (const entry of await readdir(target)) await rm(path.join(target, entry), options)
        throw busy('EBUSY')
    }
    const left = await warned(() => discardTemporaryDirectory(directory, { attempts: 2, pauseMs: 1, remove: stubborn }))
    assert.equal(left.outcome.removed, false)
    assert.equal(left.warnings.length, 1)
    assert.equal(left.warnings[0],
        `The temporary directory is left in place — still there after 2 attempts (EBUSY); in it now: nothing: ${directory}`)

    // A directory that keeps one entry says which.
    const kept = await mkdtemp(path.join(tmpdir(), 'qwen-remove-directory-kept-'))
    await writeFile(path.join(kept, 'app.log'), 'x')
    const untouched = await warned(() => discardTemporaryDirectory(kept, {
        attempts: 2, pauseMs: 1, remove: async () => { throw busy('EPERM') }
    }))
    assert.equal(untouched.outcome.removed, false)
    assert.equal(untouched.warnings[0],
        `The temporary directory is left in place — still there after 2 attempts (EPERM); in it now: app.log: ${kept}`)

    // A failure that is not a lock is said the same way, and still fails nothing.
    const odd = await warned(() => discardTemporaryDirectory(kept, {
        remove: async () => { throw new Error('scan failed') }
    }))
    assert.equal(odd.outcome.removed, false)
    assert.equal(odd.warnings[0],
        `The temporary directory is left in place — still there after 1 attempts (scan failed); in it now: app.log: ${kept}`)

    // A directory that goes is not spoken of.
    const gone = await warned(() => discardTemporaryDirectory(kept))
    assert.equal(gone.outcome.removed, true)
    assert.deepEqual(gone.warnings, [])
})
