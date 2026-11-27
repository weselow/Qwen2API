const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parse } = require('yaml')
const { planRelease, validateMetadata } = require('../tools/release-metadata.cjs')
const { findRelease, shouldUpdateLatest, validateExistingRelease, validateImageOwnership, verifyChecksum } = require('../tools/publish-release.cjs')

const packageMetadata = { name: 'qwen2api', version: '2026.09.11.12.00' }
const previousVersion = '2026.08.26.12.30'
const commit = 'a'.repeat(40)
const readWorkflow = filename => parse(readFileSync(path.join(__dirname, '../.github/workflows', filename), 'utf8'))

test('release metadata supports date versions but rejects unsafe tag input', () => {
  assert.equal(validateMetadata(packageMetadata).tag, 'v2026.09.11.12.00')
  for (const version of ['', '../escape', '1.0\ninjected=true', '1.0;echo', '1/2', '1..2', '1.0.', '1.lock']) {
    assert.throws(() => validateMetadata({ ...packageMetadata, version }))
  }
})

test('only main version changes auto-publish; unchanged package fields do not', () => {
  const inputs = { eventName: 'push', ref: 'refs/heads/main', previousVersion, packageMetadata }
  assert.equal(planRelease(inputs).publish, true)
  assert.equal(planRelease({ ...inputs, previousVersion: packageMetadata.version }).shouldRun, false)
  assert.equal(planRelease({ ...inputs, previousVersion: null }).shouldRun, false)
  assert.equal(planRelease({ ...inputs, ref: 'refs/heads/develop' }).shouldRun, false)
  assert.equal(planRelease({ ...inputs, ref: 'refs/tags/v1' }).shouldRun, false)
  assert.equal(planRelease({ ...inputs, eventName: 'pull_request' }).publish, false)
})

test('manual builds are dry runs unless publishing on main is explicitly requested', () => {
  const inputs = { eventName: 'workflow_dispatch', ref: 'refs/heads/experiment', packageMetadata }
  assert.equal(planRelease(inputs).shouldRun, true)
  assert.equal(planRelease(inputs).publish, false)
  assert.throws(() => planRelease({ ...inputs, manualPublish: true }), /only from main/)
  assert.equal(planRelease({ ...inputs, ref: 'refs/heads/main', manualPublish: true }).publish, true)
})

test('published releases and version tags on another commit cannot be overwritten', () => {
  assert.doesNotThrow(() => validateExistingRelease({ commit }))
  assert.doesNotThrow(() => validateExistingRelease({ commit, tagCommit: commit, release: { draft: true } }))
  assert.throws(() => validateExistingRelease({ commit, tagCommit: 'b'.repeat(40) }), /another commit/)
  assert.throws(() => validateExistingRelease({ commit, tagCommit: commit, release: { draft: false } }), /already published/)
})

test('draft discovery uses the draft-aware CLI and does not hide authentication failures', () => {
  const draft = findRelease('owner/repo', 'v1', (command, argumentsList) => {
    assert.equal(command, 'gh')
    assert.deepEqual(argumentsList, ['release', 'view', 'v1', '--repo', 'owner/repo', '--json', 'isDraft'])
    return JSON.stringify({ isDraft: true })
  })
  assert.deepEqual(draft, { draft: true })
  assert.equal(findRelease('owner/repo', 'v1', () => { throw { stderr: 'release not found' } }), null)
  assert.throws(() => findRelease('owner/repo', 'v1', () => { throw new Error('authentication failed') }), /authentication/)
})

test('latest tolerates later docs commits but not a newer version or divergent history', () => {
  const inputs = { version: '1.0', mainVersion: '1.0', comparisonStatus: 'identical' }
  assert.equal(shouldUpdateLatest(inputs), true)
  assert.equal(shouldUpdateLatest({ ...inputs, comparisonStatus: 'ahead' }), true)
  assert.equal(shouldUpdateLatest({ ...inputs, mainVersion: '2.0', comparisonStatus: 'ahead' }), false)
  assert.equal(shouldUpdateLatest({ ...inputs, comparisonStatus: 'diverged' }), false)
  assert.equal(shouldUpdateLatest({ ...inputs, comparisonStatus: 'behind' }), false)
})

test('legacy Docker version tags cannot be overwritten just because no GitHub release exists', () => {
  const image = { os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': commit } } }
  assert.doesNotThrow(() => validateImageOwnership(image, commit))
  assert.doesNotThrow(() => validateImageOwnership({ 'linux/amd64': image, 'linux/arm64': { ...image, architecture: 'arm64' } }, commit))
  assert.throws(() => validateImageOwnership(image, 'b'.repeat(40)), /Docker version already belongs/)
  assert.throws(() => validateImageOwnership({ ...image, config: {} }, commit), /Docker version already belongs/)
  assert.throws(() => validateImageOwnership({}, commit), /no identifiable image config/)
})

test('artifact verification rejects changed archives and mismatched filenames', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'qwen-release-checksum-'))
  try {
    const archive = path.join(directory, 'test.tar.gz')
    writeFileSync(archive, 'artifact bytes')
    const digest = createHash('sha256').update('artifact bytes').digest('hex')
    writeFileSync(`${archive}.sha256`, `${digest}  test.tar.gz\n`)
    assert.equal(verifyChecksum(archive), `${digest}  test.tar.gz`)
    writeFileSync(archive, 'changed bytes')
    assert.throws(() => verifyChecksum(archive), /Checksum mismatch/)
    writeFileSync(archive, 'artifact bytes')
    writeFileSync(`${archive}.sha256`, `${digest}  other.tar.gz\n`)
    assert.throws(() => verifyChecksum(archive), /Checksum mismatch/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('release uses main package filtering, explicit manual publishing, and a verification dependency', () => {
  const release = readWorkflow('release.yml')
  assert.deepEqual(Object.keys(release.on).sort(), ['push', 'workflow_dispatch'])
  assert.deepEqual(release.on.push, { branches: ['main'], paths: ['package.json'] })
  assert.equal(release.on.workflow_dispatch.inputs.publish.default, false)
  assert.equal(release.jobs.publish.concurrency['cancel-in-progress'], false)
  assert.equal(release.jobs.publish.concurrency.queue, 'max')
  assert.equal(release.jobs.verify.uses, './.github/workflows/verify.yml')
  assert.deepEqual(release.jobs.publish.needs, ['prepare', 'verify'])
  assert.equal(release.jobs.publish.if, "needs.prepare.outputs.publish == 'true'")
  assert.equal(release.jobs.publish.environment, 'release')
})

test('CI and reusable verification cannot publish or consume deployment secrets', () => {
  const ci = readWorkflow('ci.yml')
  const verification = readWorkflow('verify.yml')
  assert.deepEqual(ci.permissions, { contents: 'read' })
  assert.deepEqual(verification.permissions, { contents: 'read' })
  assert.equal(ci.jobs.verify.uses, './.github/workflows/verify.yml')
  const text = JSON.stringify(verification)
  assert.doesNotMatch(text, /secrets\.|login-action|docker push|gh release/)
  for (const job of Object.values(verification.jobs)) {
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false)
    }
  }
})


test('CI ignores docs-only changes and only runs push checks on integration branches', () => {
  const ci = readWorkflow('ci.yml')
  const docs = ['**/*.md', 'docs/**']
  assert.deepEqual(ci.on, {
    push: { branches: ['main', 'production'], 'paths-ignore': docs },
    pull_request: { 'paths-ignore': docs }
  })
  assert.deepEqual(ci.jobs.verify.with, { 'filter-builds': true })
})

test('build filtering is opt-in for CI and preserves all Release checks', () => {
  const release = readWorkflow('release.yml')
  const verification = readWorkflow('verify.yml')
  assert.equal(release.jobs.verify.with?.['filter-builds'], undefined)
  const input = verification.on.workflow_call.inputs['filter-builds']
  assert.equal(input.type, 'boolean')
  assert.equal(input.default, false)
  assert.equal(verification.jobs.regression.if, undefined)
  assert.equal(verification.jobs.regression.needs, undefined)
  assert.equal(verification.jobs.changes.if, undefined)
  assert.equal(verification.jobs.changes.steps[0].if, 'inputs.filter-builds')
  assert.equal(verification.jobs.changes.steps[0].with['fetch-depth'], 0)
  assert.equal(verification.jobs.changes.outputs.binaries, '${{ steps.plan.outputs.binaries }}')
  assert.equal(verification.jobs.frontend.needs, 'changes')
  assert.equal(verification.jobs.frontend.if, "needs.changes.outputs.binaries == 'true'")
})

// The one test here that needs git makes a scratch repository. Where there is
// none — a bare node image without the gate recipe's git
// (tools/gate-image/Dockerfile) — it says so and skips itself; the gate then
// counts the skipped test and fails NOT_ALL_RAN: a missing tool must not pass
// for a passed test (Qwen2API-288).
const hasGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch { return false }
}

test('build detection uses the event diff and defaults to building if the diff is unavailable', t => {
  if (!hasGit()) {
    t.diagnostic('SKIP: git is not installed, and this test makes a scratch repository. Build it into the image (tools/gate-image/Dockerfile).')
    return t.skip('git is not installed')
  }
  const plan = readWorkflow('verify.yml').jobs.changes.steps.find(step => step.id === 'plan')
  assert.deepEqual(plan.env, {
    FILTER_BUILDS: '${{ inputs.filter-builds }}',
    BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.before }}',
    HEAD_SHA: '${{ github.event.pull_request.head.sha || github.event.after }}'
  })

  const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-ci-diff-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const commitFile = (filename, contents) => {
    const file = path.join(cwd, filename)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
    git('add', '--', filename)
    git('commit', '-qm', 'Update fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '--initial-branch=main')
  git('config', 'user.name', 'CI workflow test')
  git('config', 'user.email', 'ci@example.com')
  git('config', 'commit.gpgsign', 'false')
  const fork = commitFile('src/base.js', 'original')
  git('branch', 'feature')
  const main = commitFile('src/base.js', 'updated on main')
  git('checkout', '-q', 'feature')
  const testsOnly = commitFile('tests/example.test.js', 'test')
  const script = path.join(cwd, 'plan.cjs')
  const output = path.join(cwd, 'output')
  writeFileSync(script, plan.run)

  const requiresBuilds = (base, head, event = 'push', filter = 'true') => {
    writeFileSync(output, '')
    execFileSync(process.execPath, [script], {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        FILTER_BUILDS: filter,
        GITHUB_EVENT_NAME: event,
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_OUTPUT: output
      }
    })
    const result = readFileSync(output, 'utf8')
    assert.match(result, /^binaries=(true|false)\n$/)
    return result === 'binaries=true\n'
  }

  // The base branch's changes don't count towards the PR's diff.
  assert.equal(requiresBuilds(main, testsOnly, 'pull_request'), false)
  assert.equal(requiresBuilds(fork, testsOnly), false)
  assert.equal(requiresBuilds(fork, testsOnly, 'push', 'false'), true)
  assert.equal(requiresBuilds(fork, testsOnly, 'workflow_dispatch'), true)
  assert.equal(requiresBuilds(testsOnly, testsOnly), true)
  assert.equal(requiresBuilds('0'.repeat(40), testsOnly), true)
  assert.equal(requiresBuilds('', testsOnly), true)

  for (const file of [
    'src/another file.js', 'signin-worker/worker.js', 'public/src/page.vue',
    'public/package.json', 'public/bun.lock', 'docker/Dockerfile', 'tools/build.mjs',
    'package.json', 'bun.lock', '.dockerignore', '.github/workflows/ci.yml'
  ]) {
    const before = git('rev-parse', 'HEAD')
    const after = commitFile(file, 'build input')
    assert.equal(requiresBuilds(before, after), true, file)
  }

  const beforeRename = git('rev-parse', 'HEAD')
  assert.equal(requiresBuilds(main, beforeRename, 'pull_request'), true)
  git('mv', 'src/base.js', 'tests/moved.js')
  git('commit', '-qm', 'Move source out of build inputs')
  assert.equal(requiresBuilds(beforeRename, git('rev-parse', 'HEAD')), true)
})

test('native executables and Alpine images are tested before artifact export', () => {
  const binaries = readWorkflow('verify.yml').jobs.binaries
  // After the gate, and after the worker's tests on the Node of its production image (Qwen2API-25q).
  assert.deepEqual(binaries.needs, ['regression', 'frontend', 'worker-node20'])
  assert.deepEqual(binaries.strategy.matrix.include.map(entry => entry.platform), ['linux-x64', 'linux-arm64', 'windows-x64'])
  assert.equal(binaries.strategy.matrix.include.find(entry => entry.platform === 'linux-arm64').runner, 'ubuntu-24.04-arm')
  const steps = binaries.steps
  assert.ok(steps.some(step => step.run === 'bun install --frozen-lockfile --production'))
  const binaryTest = steps.findIndex(step => step.run?.includes('test:bun --binary'))
  const archive = steps.findIndex(step => step.run?.includes('package-binary.mjs'))
  const containerTest = steps.findIndex(step => step.run?.includes('test:bun --docker-image'))
  const imageExport = steps.findIndex(step => step.run?.startsWith('docker save'))
  assert.ok(binaryTest >= 0 && archive > binaryTest)
  assert.ok(containerTest > archive && imageExport > containerTest)
  const build = steps.find(step => step.uses?.startsWith('docker/build-push-action@'))
  assert.equal(build.with['build-args'], 'BINARY_SOURCE=prebuilt')
  assert.equal(build.with.load, true)
  assert.notEqual(build.with.push, true)
})
