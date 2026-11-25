const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// The guard wraps the runtime's own clients, so it is probed in a process of
// its own: this file shares the gate's process with every other one.
const GUARD = path.join(__dirname, '..', 'tools', 'net-guard.js')
const CHILD = [
    `const guard = require(${JSON.stringify(GUARD)})`,
    'guard.install()',
    "if (process.argv[1] === 'fetch') {",
    "    globalThis.fetch = () => Promise.reject(Object.assign(new Error('this wrap is missing'), { code: 'ENOENT' }))",
    '}',
    'guard.selfTest().then(',
    '    results => console.log(JSON.stringify({',
    '        results, blocked: guard.install().blocked, noProxy: [process.env.no_proxy, process.env.NO_PROXY]',
    '    })),',
    "    error => { console.log('FAILED: ' + error.message); process.exitCode = 2 }",
    ')'
].join('\n')
// What the child does with the guard: nothing more, or one wrap taken off again.
const probe = (environment = {}, unwrapped = '') => spawnSync(process.execPath,
    ['--no-warnings', '-e', CHILD, ...(unwrapped ? [unwrapped] : [])],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...environment } })
const refused = code => code.split('<-').includes('ENETGUARD')

test('the network guard refuses every way to the outside world with its own error, and leaves the loopback alone', () => {
    const child = probe()
    assert.equal(child.status, 0, child.stderr || child.stdout)
    const { results, blocked } = JSON.parse(child.stdout)
    const outside = results.filter(result => result.label.startsWith('O '))
    const local = results.filter(result => result.label.startsWith('L '))
    assert.ok(outside.length >= 20, 'the clients there are in Node and in Bun are each probed')
    for (const { label, code } of outside) assert.ok(refused(code), `${label}: ${code}`)
    for (const { label, code } of local) assert.ok(code.startsWith('OK:'), `${label}: ${code}`)
    // Refused before anything was sent: each refusal is the guard's own record of it.
    assert.equal(blocked.length, outside.length)
    assert.ok(blocked.every(entry => ['192.0.2.1', 'outside.invalid', '(any)'].includes(entry.host)),
        'nothing but the reserved targets was ever refused, so nothing else was ever asked for')
})

test('the self-test fails when one of the wraps does not hold', () => {
    const child = probe({}, 'fetch')
    assert.equal(child.status, 2)
    assert.match(child.stdout, /FAILED: net-guard: the self-test failed in this runtime — not refused: O fetch to an outside address \(ENOENT\)/)
})

test('the loopback is exempted from a proxy in the environment, in both spellings, keeping what was there', () => {
    const child = probe({ no_proxy: 'example.invalid', NO_PROXY: 'example.invalid' })
    assert.equal(child.status, 0, child.stderr || child.stdout)
    assert.deepEqual(JSON.parse(child.stdout).noProxy, ['example.invalid,127.0.0.1,localhost,::1', 'example.invalid,127.0.0.1,localhost,::1'])
})

test('the self-test names no real host: should a wrap not hold, nothing real is asked', () => {
    const source = fs.readFileSync(GUARD, 'utf8')
    assert.doesNotMatch(source, /qwen/i)
    // The hosts its probes do name are reserved for documentation (RFC 5737, RFC 6761).
    assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1|192\.0\.2\.1|localhost|outside\.invalid|\$\{OUTSIDE\})/)
})
