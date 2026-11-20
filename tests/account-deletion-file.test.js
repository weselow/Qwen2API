const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
process.env.API_KEY = 'account-deletion-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
const config = require('../src/config')
const DataPersistence = require('../src/utils/data-persistence')
const accountManager = require('../src/utils/account')
const router = require('../src/routes/accounts')
const deleteHandler = router.stack.find(layer => layer.route?.path === '/deleteAccount').route.stack.at(-1).handle
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const token = exp => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
const record = email => ({ email, password: 'synthetic', token: token(Math.floor(Date.now() / 1000) + 3600), stats: { retained: 7 } })

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })
const withFile = async fn => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-account-delete-'))
  const persistence = new DataPersistence()
  persistence.dataFilePath = path.join(dir, 'data.json')
  persistence.backupFilePath = `${persistence.dataFilePath}.bak`
  const original = { mode: config.dataSaveMode, persistence: accountManager.dataPersistence, accounts: accountManager.accountTokens, refresh: accountManager.tokenManager.refreshToken }
  const a = record('removed@example.invalid'), b = record('retained@example.invalid')
  const data = { accounts: [a, b], settings: { modelMap: 'keep-me' }, defaultHeaders: { retained: true } }
  await fs.writeFile(persistence.dataFilePath, JSON.stringify(data))
  await fs.writeFile(persistence.backupFilePath, JSON.stringify(data))
  config.dataSaveMode = 'file'
  accountManager.dataPersistence = persistence
  accountManager.accountTokens = [a, b]
  accountManager.accountRotator.setAccounts([a, b])
  const read = async target => JSON.parse(await fs.readFile(target || persistence.dataFilePath, 'utf8'))
  try { await fn({ persistence, a, b, data, read }) }
  finally {
    for (const timer of persistence._statsPersistTimers.values()) clearTimeout(timer)
    config.dataSaveMode = original.mode
    accountManager.dataPersistence = original.persistence
    accountManager.accountTokens = original.accounts
    accountManager.tokenManager.refreshToken = original.refresh
    accountManager.accountRotator.setAccounts(original.accounts)
    assert.equal(path.dirname(dir), os.tmpdir())
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('DELETE persists only the requested account, including recovery backup and restart', async () => {
  await withFile(async ({ persistence, a, b, data, read }) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    await deleteHandler({ body: { email: a.email } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(accountManager.getAllAccountKeys().map(x => x.email), [b.email])
    const saved = await read()
    assert.deepEqual(saved, { ...data, accounts: [b] })
    assert.deepEqual(await read(persistence.backupFilePath), saved)
    const restarted = new DataPersistence()
    restarted.dataFilePath = persistence.dataFilePath; restarted.backupFilePath = persistence.backupFilePath
    assert.deepEqual(await restarted.loadAccounts(), [b])
    assert.equal(await accountManager.removeAccount(b.email), true)
    assert.deepEqual((await read()).accounts, [])
    assert.deepEqual((await read(persistence.backupFilePath)).accounts, [])
    // Recovery after deleting the LAST record must not resurrect an old backup.
    await fs.writeFile(persistence.dataFilePath, '{broken')
    assert.deepEqual(await restarted.loadAccounts(), [])
  })
})

test('failed storage deletion leaves memory, rotation, primary and backup unchanged', async () => {
  await withFile(async ({ persistence, a, data, read }) => {
    const write = persistence._writeFileAtomic
    persistence._writeFileAtomic = async function (target, content) {
      if (target === this.dataFilePath) throw new Error('synthetic disk failure')
      return write.call(this, target, content)
    }
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    await deleteHandler({ body: { email: a.email } }, res)
    assert.equal(res.statusCode, 500)
    assert.equal(accountManager.getAllAccountKeys().length, 2)
    assert.equal(accountManager.accountRotator.accounts.length, 2)
    assert.deepEqual(await read(), data)
    assert.deepEqual(await read(persistence.backupFilePath), data)
    persistence._writeFileAtomic = write
    assert.equal(await accountManager.deleteAccount(a.email), true, 'failed mutation must not poison either queue')
  })
})

test('pending stats and stale single/bulk writes cannot resurrect a deleted record; explicit add can', async () => {
  await withFile(async ({ persistence, a, b, read }) => {
    assert.equal(persistence.saveAccountStats(a.email, { chat: { input: 99 } }), true)
    assert.equal(await accountManager.removeAccount(a.email), true)
    assert.equal(persistence._statsPersistTimers.has(a.email), false)
    assert.equal(persistence._statsPendingPayload.has(a.email), false)
    assert.equal(persistence.saveAccountStats(a.email, { chat: { input: 101 } }), false)
    assert.equal(await persistence.saveAccount(a.email, { stats: { chat: { input: 102 } } }), false)
    await persistence.saveAllAccounts([a, b])
    assert.deepEqual((await read()).accounts.map(x => x.email), [b.email])
    assert.equal(await persistence.saveSettings({ unrelated: true }), true)
    assert.equal(await accountManager.addAccountWithToken(a.email, a.password, a.token, 123), true)
    assert.equal((await read()).accounts.length, 2)
    assert.equal(await persistence.saveAccount(a.email, { stats: { restored: true } }), true)
  })
})

test('a refresh already in flight finishes before deletion; a later refresh cannot start login', async () => {
  await withFile(async ({ a, read }) => {
    const entered = deferred(), release = deferred()
    let refreshes = 0
    accountManager.tokenManager.refreshToken = async account => { refreshes++; entered.resolve(); await release.promise; return { ...account, token: account.token } }
    const refresh = accountManager.refreshAccountToken(a.email)
    await entered.promise
    const removal = accountManager.removeAccount(a.email)
    release.resolve()
    assert.equal(await refresh, true)
    assert.equal(await removal, true)
    assert.equal(await accountManager.refreshAccountToken(a.email), false)
    assert.equal(refreshes, 1)
    assert.equal((await read()).accounts.some(x => x.email === a.email), false)
  })
})

test('daily batch queued during deletion cannot put the old snapshot back', async () => {
  await withFile(async ({ persistence, a, b, read }) => {
    const entered = deferred(), release = deferred(), write = persistence._writeFileAtomic
    persistence._writeFileAtomic = async function (target, content) {
      if (target === this.dataFilePath && !JSON.parse(content).accounts.some(x => x.email === a.email)) { entered.resolve(); await release.promise }
      return write.call(this, target, content)
    }
    const removal = accountManager.removeAccount(a.email)
    await entered.promise
    const dailyBatch = persistence.saveAllAccounts([a, b])
    release.resolve()
    assert.equal(await removal, true)
    assert.equal(await dailyBatch, true)
    assert.deepEqual((await read()).accounts.map(x => x.email), [b.email])
  })
})

test('an unsuccessful add rolls back its own record when another account is deleted concurrently', async () => {
  await withFile(async ({ persistence, a, b, read }) => {
    const entered = deferred(), release = deferred(), save = persistence.saveAccount
    const email = 'new-failed@example.invalid'
    persistence.saveAccount = async function (address, ...args) {
      if (address === email) { entered.resolve(); await release.promise; return false }
      return save.call(this, address, ...args)
    }
    const addition = accountManager.addAccountWithToken(email, 'synthetic', a.token, 123)
    await entered.promise
    assert.equal(await accountManager.removeAccount(a.email), true)
    release.resolve()
    assert.equal(await addition, false)
    assert.deepEqual(accountManager.getAllAccountKeys().map(x => x.email), [b.email])
    assert.deepEqual((await read()).accounts.map(x => x.email), [b.email])
  })
})
