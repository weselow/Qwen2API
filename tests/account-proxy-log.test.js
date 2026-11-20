const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = 'proxy-log-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'

const { formatProxyForLog } = require('../src/utils/proxy-helper')
const accountManager = require('../src/utils/account')
const { logger } = require('../src/utils/logger')

test('proxy log formatting keeps endpoints and omits credentials, paths and query values', () => {
  assert.equal(formatProxyForLog(null), 'direct')
  assert.equal(formatProxyForLog('http://proxy.example:3128'), 'http://proxy.example:3128')
  assert.equal(formatProxyForLog('http://old-user:old-password@proxy.example:3128/private?key=secret#fragment'), 'http://***@proxy.example:3128')
  assert.equal(formatProxyForLog('socks5h://user:p%40ss@[::1]:1080'), 'socks5h://***@[::1]:1080')
  assert.equal(formatProxyForLog('http://user:bad-password@[::1'), '[invalid proxy URL]')
  assert.equal(formatProxyForLog('invalid-user:invalid-password'), '[invalid proxy URL]')
})

test('updating an account proxy logs masked endpoints but persists the original URL', async () => {
  await accountManager._initPromise
  const original = { accounts: accountManager.accountTokens, save: accountManager.dataPersistence.saveAccount, log: logger.success }
  const previous = 'http://previous-user:previous-password@old.example:8080'
  const next = 'socks5h://next-user:next%40password@new.example:1080'
  const account = { email: 'proxy-log@example.invalid', proxy: previous }
  const lines = []
  let persisted
  accountManager.accountTokens = [account]
  accountManager.dataPersistence.saveAccount = async (email, payload) => { persisted = { email, ...payload }; return true }
  logger.success = message => lines.push(String(message))
  try {
    assert.equal(await accountManager.updateAccountProxy(account.email, next), true)
    assert.equal(account.proxy, next)
    assert.equal(persisted.proxy, next)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /http:\/\/\*\*\*@old\.example:8080 → socks5h:\/\/\*\*\*@new\.example:1080/)
    for (const secret of ['previous-user', 'previous-password', 'next-user', 'next%40password', 'next@password']) assert.equal(lines[0].includes(secret), false)
    assert.equal(await accountManager.updateAccountProxy(account.email, null), true)
    assert.match(lines[1], /socks5h:\/\/\*\*\*@new\.example:1080 → direct/)
  } finally {
    accountManager.accountTokens = original.accounts
    accountManager.dataPersistence.saveAccount = original.save
    logger.success = original.log
    accountManager.destroy()
  }
})
