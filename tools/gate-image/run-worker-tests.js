#!/usr/bin/env node
'use strict'

/**
 * The sign-in worker's test files, one process per file, on the Node of the
 * image they run in.
 *
 * WHY THIS EXISTS
 * ---------------
 * The worker of prod is built FROM node:20-slim (signin-worker/Dockerfile),
 * while the gate (tools/test-gate.js) and CI's `regression` job run every test
 * on Node 24: until this, the worker's code never ran in CI on the version it
 * runs on in production (Qwen2API-25q).
 *
 * The gate script itself does not run on Node 20 (`--test-isolation` needs
 * Node 22), so this is the per-file form: each file runs in a process of its
 * own — `node --test-force-exit <file>`, without the parent runner of
 * `node --test`, whose pipe to the file's process can lose the tail of its
 * report under load (tools/test-gate.js, "WHY THIS EXISTS"). On both Node
 * majors the plain form runs the file's tests in that very process, so
 * nothing is counted that did not arrive. CI's `worker-node20` job runs it
 * in the image built from tools/gate-image/Dockerfile.node20; the same
 * command on the node24 image puts the two versions side by side (AGENTS.md,
 * "The test gate").
 *
 * No count is compared with tests/expected-counts.json: the number of tests
 * some of these files generate varies with the Node version (Qwen2API-25q).
 * Red is a failed, cancelled, skipped or todo test, a file with no test at
 * all, a process that was killed (past WORKER_TESTS_TIMEOUT_MS) or did not
 * exit 0, a file that reported no summary, or a pattern nothing matches any
 * more.
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { parseSummary } = require('../test-gate.js')

const ROOT = path.resolve(__dirname, '..', '..')
const TESTS = path.join(ROOT, 'tests')
// The worker's own tests, and the application's side that talks to it.
const PATTERNS = ['signin-worker-*.test.js', 'browser-egress*.test.js', 'account-removed-guard.test.js']
// What CI's `regression` job sets for the gate; the caller's environment wins.
const ENVIRONMENT = {
  API_KEY: 'ci-test-key',
  DATA_SAVE_MODE: 'none',
  ACCOUNTS: '',
  ENABLE_CLI: 'false',
  ENABLE_FILE_LOG: 'false',
  CACHE_MODE: 'default',
  SEARCH_INFO_MODE: 'text'
}
const BAR = '='.repeat(72)

// `name` is a plain name with `*` for any run of characters; a dot is a dot.
const matcher = pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/\./g, '\\.')).join('.*')}$`)

/**
 * The files the patterns name, in the order of the patterns, and the patterns
 * nothing matches any more — which is not a pass either.
 * @param {string[]} [names] the names in `tests/`
 * @returns {{files:string[], missing:string[]}}
 */
function listFiles (names = fs.readdirSync(TESTS).sort()) {
  const files = []
  const missing = []
  for (const pattern of PATTERNS) {
    const re = matcher(pattern)
    const found = names.filter(name => re.test(name)).map(name => `tests/${name}`)
    if (found.length === 0) missing.push(pattern)
    files.push(...found)
  }
  return { files: [...new Set(files)], missing }
}

/**
 * Whether one file's run counts as a pass. The order is the gate's: a real
 * failure is never reported as something else, and a test that never came to
 * its end is a failure, not a quiet finish. A test that was skipped keeps its
 * place in the count, so it is looked for on its own — as in the gate.
 * @param {{summary:ReturnType<typeof parseSummary>, status:number|null, signal:string|null, timedOut?:boolean}} run
 * @returns {{ok:boolean, reason:string, detail:string}}
 */
function judge ({ summary, status, signal, timedOut = false }) {
  if (summary && summary.fail > 0) return { ok: false, reason: 'TEST_FAILURES', detail: `${summary.fail} test(s) failed` }
  if (summary && summary.cancelled > 0) return { ok: false, reason: 'CANCELLED', detail: `${summary.cancelled} test(s) cancelled` }
  if (timedOut) return { ok: false, reason: 'TIMEOUT', detail: 'the process did not finish inside WORKER_TESTS_TIMEOUT_MS and was killed' }
  if (signal) return { ok: false, reason: 'KILLED', detail: `the process was killed by ${signal}` }
  if (!summary) return { ok: false, reason: 'NO_SUMMARY', detail: 'no summary block — the process crashed, hung, or its output was lost' }
  if (status !== 0) return { ok: false, reason: 'RUNNER_EXIT', detail: `the process exited ${status} despite reporting fail 0` }
  const notRun = summary.skipped + summary.todo
  if (notRun > 0) return { ok: false, reason: 'NOT_ALL_RAN', detail: `${notRun} test(s) did not run (skipped ${summary.skipped}, todo ${summary.todo})` }
  if (summary.tests === 0) return { ok: false, reason: 'NO_TESTS', detail: 'the file ran no test' }
  return { ok: true, reason: 'OK', detail: `${summary.tests} tests / 0 fail` }
}

// spawnSync says it killed the process at its own timeout by an error on the result, and by nothing else.
const timedOutOf = child => Boolean(child.error && child.error.code === 'ETIMEDOUT')

function runFile (file, timeoutMs) {
  const started = Date.now()
  const child = spawnSync(process.execPath, ['--test-force-exit', file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...ENVIRONMENT, ...process.env }
  })
  // The runner's own output first, as the gate prints it: what went red is read above the verdict.
  process.stdout.write(child.stdout || '')
  process.stderr.write(child.stderr || '')
  const summary = parseSummary(`${child.stdout || ''}\n${child.stderr || ''}`)
  const verdict = judge({ summary, status: child.status, signal: child.signal, timedOut: timedOutOf(child) })
  return { file, verdict, summary, seconds: (Date.now() - started) / 1000 }
}

function main () {
  const node = process.versions.node
  const timeoutMs = Number(process.env.WORKER_TESTS_TIMEOUT_MS || 600000)
  console.log(`[worker-tests] node v${node}, at most ${Math.round(timeoutMs / 1000)} s per file`)
  const { files, missing } = listFiles()
  const red = []
  let tests = 0
  let failed = 0
  for (const pattern of missing) {
    red.push(`  ${pattern}: NO_FILE — no test file matches this pattern any more`)
  }
  for (const file of files) {
    const { verdict, summary, seconds } = runFile(file, timeoutMs)
    tests += summary ? summary.tests : 0
    failed += summary ? summary.fail + summary.cancelled : 0
    console.log(`[worker-tests] ${verdict.ok ? 'PASS' : `FAIL [${verdict.reason}]`} ${file}: ${verdict.detail} (${seconds.toFixed(1)} s)`)
    if (!verdict.ok) red.push(`  ${file}: ${verdict.reason} — ${verdict.detail}`)
  }
  const total = `${files.length} file(s) / ${tests} tests / ${failed} failed or cancelled`
  if (red.length) {
    console.error(`${BAR}\nWORKER TESTS ON NODE v${node}: FAIL — ${total}; red:\n${red.join('\n')}\n${BAR}`)
    process.exit(1)
  }
  console.log(`${BAR}\nWORKER TESTS ON NODE v${node}: PASS — ${total}\n${BAR}`)
}

module.exports = { PATTERNS, listFiles, judge, timedOutOf }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`${BAR}\nWORKER TESTS: FAIL [CRASH]\n${error && error.stack ? error.stack : error}\n${BAR}`)
    process.exit(8)
  }
}
