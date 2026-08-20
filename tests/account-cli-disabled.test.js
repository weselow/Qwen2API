const test = require('node:test')
const assert = require('node:assert/strict')

const config = require('../src/config/index.js')
const accountManager = require('../src/utils/account.js')
const { getAccountCliState } = require('../src/utils/cli-support.js')

/**
 * ENABLE_CLI=false 时 loadAccountTokens 必须把已加载的账户标记为 disabled，
 * 否则 cli-support 会按 (cli_info=null, cli_unavailable_reason=null) 判定为
 * cli_pending，管理面板永远显示「CLI 初始化中」。
 */
test('loadAccountTokens marks every account as cli_disabled when CLI is off', async () => {
  await accountManager._initPromise

  const originalCliEnabled = config.cliEnabled
  const originalLoadAccounts = accountManager.dataPersistence.loadAccounts
  const originalValidate = accountManager._validateAndCleanTokens
  const originalDailyResetTimer = accountManager._setupDailyResetTimer
  const originalAccounts = accountManager.accountTokens

  config.cliEnabled = false
  accountManager.dataPersistence.loadAccounts = async () => ([
    { email: 'a@example.com', token: 'token-a' },
    { email: 'b@example.com', token: 'token-b', cli_info: { request_number: 7 } }
  ])
  accountManager._validateAndCleanTokens = async () => { }
  // 每日重置定时器会让 node --test 进程挂住，测试里不需要它
  accountManager._setupDailyResetTimer = () => { }

  try {
    await accountManager.loadAccountTokens()

    assert.equal(accountManager.accountTokens.length, 2)
    for (const account of accountManager.accountTokens) {
      assert.equal(account.cli_unavailable_reason, 'disabled')
      assert.equal(account.cli_info, null)
      assert.equal(getAccountCliState(account).status.kind, 'cli_disabled')
    }
  } finally {
    config.cliEnabled = originalCliEnabled
    accountManager.dataPersistence.loadAccounts = originalLoadAccounts
    accountManager._validateAndCleanTokens = originalValidate
    accountManager._setupDailyResetTimer = originalDailyResetTimer
    accountManager.accountTokens = originalAccounts
    accountManager.destroy()
  }
})
