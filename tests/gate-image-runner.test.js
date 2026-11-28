const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('yaml')
const { parseSummary } = require('../tools/test-gate.js')
const { PATTERNS, listFiles, judge, timedOutOf } = require('../tools/gate-image/run-worker-tests.js')

// Qwen2API-25q: the sign-in worker's own test files run on Node 20, the Node of
// its production image, each in a process of its own (tools/gate-image/run-worker-tests.js).
// The runner compares no count, so what makes a file red is all there is.

const summary = (tests, { fail = 0, cancelled = 0, skipped = 0, todo = 0, pass = tests - fail - cancelled - skipped - todo } = {}) => parseSummary(
  `ℹ tests ${tests}\nℹ suites 1\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled ${cancelled}\nℹ skipped ${skipped}\nℹ todo ${todo}\n`)
const clean = { status: 0, signal: null, timedOut: false }

// On Node 20 the queue's tests without a server ended with their waiters still in
// line — reported as cancelled, fail 0. That is not green.
test('a file with cancelled tests is red, and is said to be cancelled', () => {
  const v = judge({ summary: summary(34, { cancelled: 12, pass: 22 }), status: 1, signal: null })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'CANCELLED')
  assert.match(v.detail, /12 test\(s\) cancelled/)
})

test('a file with failed tests is red, and a real failure outranks the rest', () => {
  const v = judge({ summary: summary(34, { fail: 3, cancelled: 1 }), status: 1, signal: null })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'TEST_FAILURES')
})

test('a file that reported no summary is red — it is never subtracted quietly', () => {
  for (const run of [{ summary: null, status: 0, signal: null }, { summary: null, status: null, signal: 'SIGTERM' }]) {
    const v = judge(run)
    assert.equal(v.ok, false, JSON.stringify(run))
    assert.equal(v.reason, run.signal ? 'KILLED' : 'NO_SUMMARY')
  }
})

test('a file whose process went past its timeout is red, and is said to be a timeout', () => {
  const v = judge({ summary: null, status: null, signal: 'SIGTERM', timedOut: true })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'TIMEOUT')
  // A report that arrived before the kill does not make it a pass either.
  assert.equal(judge({ summary: summary(10), status: null, signal: 'SIGTERM', timedOut: true }).reason, 'TIMEOUT')
})

test('only the error spawnSync reports for its own timeout says "timed out" — a process killed otherwise was killed', () => {
  assert.equal(timedOutOf({ error: { code: 'ETIMEDOUT' } }), true)
  assert.equal(timedOutOf({ error: undefined, signal: 'SIGTERM' }), false)
  assert.equal(timedOutOf({}), false)
  assert.equal(judge({ summary: null, status: null, signal: 'SIGTERM', timedOut: timedOutOf({ error: undefined, signal: 'SIGTERM' }) }).reason, 'KILLED')
})

test('a file whose runner exited nonzero with fail 0 is red', () => {
  const v = judge({ summary: summary(10), status: 7, signal: null })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'RUNNER_EXIT')
})

test('a skipped or todo test is red: it keeps its place in the count, as the gate knows', () => {
  const v = judge({ summary: summary(10, { skipped: 1, pass: 9 }), ...clean })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.match(v.detail, /skipped 1/)
  assert.equal(judge({ summary: summary(10, { todo: 2, pass: 8 }), ...clean }).reason, 'NOT_ALL_RAN')
})

test('a file that ran no test at all is red, not an empty pass', () => {
  const v = judge({ summary: summary(0), ...clean })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NO_TESTS')
})

test('a file is green only with a summary, every test run, exit 0 and no signal', () => {
  const v = judge({ summary: summary(206), ...clean })
  assert.equal(v.ok, true)
  assert.equal(v.detail, '206 tests / 0 fail')
})

test('the list is the worker\'s tests, its browser-egress caller and the removed-account guard — and every pattern still finds a file', () => {
  assert.deepEqual(PATTERNS, ['signin-worker-*.test.js', 'browser-egress*.test.js', 'account-removed-guard.test.js'])
  const { files, missing } = listFiles()
  assert.deepEqual(missing, [], 'a pattern that no file matches any more is reported here')
  assert.ok(files.length >= 9, `${files.length} files`)
  assert.ok(files.includes('tests/account-removed-guard.test.js'))
  assert.ok(files.every(file => /^tests\/(signin-worker-[^/]+|browser-egress[^/]*|account-removed-guard)\.test\.js$/.test(file)), files.join(' '))
  assert.equal(new Set(files).size, files.length, 'no file runs twice')
})

test('a pattern nothing matches any more is reported, not skipped', () => {
  const { files, missing } = listFiles(['signin-worker-a.test.js', 'tool-prompt.test.js'])
  assert.deepEqual(files, ['tests/signin-worker-a.test.js'])
  assert.deepEqual(missing, ['browser-egress*.test.js', 'account-removed-guard.test.js'])
})

test('a dot in a pattern is a dot, and the files come in the order of the patterns', () => {
  const { files, missing } = listFiles(['browser-egress.test.js', 'account-removed-guard.test.js', 'signin-worker-x.test.js', 'account-removed-guardXtest.js'])
  assert.deepEqual(files, ['tests/signin-worker-x.test.js', 'tests/browser-egress.test.js', 'tests/account-removed-guard.test.js'])
  assert.deepEqual(missing, [])
})

// As the gate's own job budget is checked in tests/test-count-gate.test.js ("DEFECT 3"):
// a file that hangs is to be reported by the runner, not cut short by GitHub's job timeout.
test('the Node 20 job can contain every file running to the end of its own timeout', () => {
  const verification = parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify.yml'), 'utf8'))
  const job = verification.jobs['worker-node20']
  const step = job.steps.find(candidate => candidate.run?.includes('run-worker-tests.js'))
  const perFile = Number(/WORKER_TESTS_TIMEOUT_MS=(\d+)/.exec(step.run)[1])
  const worst = perFile * listFiles().files.length
  // The checkout, the install and the image build before the first file starts.
  assert.ok(worst + 120000 < job['timeout-minutes'] * 60000,
    `worst case ${worst}ms over the files plus two minutes does not fit the job's ${job['timeout-minutes']} minutes: ` +
    'GitHub kills the job before the runner reports, and a hung file looks like an infrastructure failure')
  // The container passes nothing the runner does not set itself.
  assert.doesNotMatch(step.run, /-e (API_KEY|DATA_SAVE_MODE|ACCOUNTS)=/)
})

test('each file runs in a process of its own — under no parent runner, whose pipe can lose the tail of a report', () => {
  // The gate's own lesson (tools/test-gate.js, "WHY THIS EXISTS"): `node --test` spawns a process
  // per file and reads its report over a pipe; under load the tail is lost, and a file that
  // failed can arrive as fewer tests and fail 0. Without `--test` the file's tests run in the
  // very process, on Node 20 as on 24, and what is reported is what happened.
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'gate-image', 'run-worker-tests.js'), 'utf8')
  assert.match(source, /spawnSync\(process\.execPath, \['--test-force-exit', file\]/)
})
