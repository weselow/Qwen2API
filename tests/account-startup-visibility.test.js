const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = 'account-startup-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'

const config = require('../src/config')
const accountManager = require('../src/utils/account')
const AccountRotator = require('../src/utils/account-rotator')

const jwt = exp => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`

test('persisted accounts stay manageable without automatic login; only valid tokens rotate', async () => {
  await accountManager._initPromise
  const saved = {
    mode: config.dataSaveMode,
    load: accountManager.dataPersistence.loadAccounts,
    login: accountManager.tokenManager.login,
    timer: accountManager._setupDailyResetTimer,
    accounts: accountManager.accountTokens
  }
  const now = Math.floor(Date.now() / 1000)
  const records = [
    { email: 'valid@example.invalid', password: 'unused', token: jwt(now + 3600) },
    { email: 'expired@example.invalid', password: 'unused', token: jwt(now - 60) },
    { email: 'missing@example.invalid', password: 'unused', token: null },
    { email: 'malformed@example.invalid', password: 'unused', token: 'invalid' }
  ]
  let logins = 0
  accountManager.dataPersistence.loadAccounts = async () => records.map(record => ({ ...record }))
  accountManager.tokenManager.login = async () => { logins += 1; throw new Error('unexpected login') }
  accountManager._setupDailyResetTimer = () => {}
  try {
    for (const mode of ['file', 'redis']) {
      config.dataSaveMode = mode
      const before = logins
      await accountManager.loadAccountTokens()
      assert.deepEqual(accountManager.getAllAccountKeys().map(a => a.email), records.map(a => a.email))
      assert.equal(logins, before)
      assert.equal(accountManager.getAccount().email, records[0].email)
      assert.equal(accountManager.getAccount([records[0].email]), null)
      // A saved expired account must reach manual refresh, rather than look missing.
      const success = await accountManager.refreshAccountToken(records[1].email)
      assert.equal(success, false)
      assert.equal(logins, before + 1)
      assert.equal(accountManager.getAllAccountKeys().length, 4)
    }
  } finally {
    config.dataSaveMode = saved.mode
    accountManager.dataPersistence.loadAccounts = saved.load
    accountManager.tokenManager.login = saved.login
    accountManager._setupDailyResetTimer = saved.timer
    accountManager.accountTokens = saved.accounts
    accountManager.accountRotator.setAccounts(saved.accounts)
    accountManager.destroy()
  }
})

test('rotation revalidates expiry and a replaced token at selection time', () => {
  let now = 100
  const record = { email: 'expiry@example.invalid', token: 110 }
  const rotator = new AccountRotator(token => token > now)
  rotator.setAccounts([record])
  assert.equal(rotator.getNextAccount(), record)
  now = 111
  assert.equal(rotator.getNextAccount(), null)
  record.token = 200
  assert.equal(rotator.getNextAccount(), record)
})
