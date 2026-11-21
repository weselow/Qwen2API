const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const express = require('express')
const axios = require('axios')

process.env.API_KEY = 'signin-test-only'
process.env.DATA_SAVE_MODE = 'none'
process.env.ENABLE_CLI = 'false'
process.env.ACCOUNTS = ''
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const { logger } = require('../src/utils/logger')
const { SigninError } = require('../src/utils/signin-error')
const routes = require('../src/routes/accounts')

const blockPage = '<html>Sorry, your request has been blocked <a href="https://errors.aliyun.com/">help</a><img src="/405.png"></html>'

test('classify Qwen signin failures without disclosing upstream data', () => {
  for (const [status, data, code] of [
    [405, blockPage, 'signin_waf_block'],
    [405, '<html>Method Not Allowed</html>', 'signin_upstream_error'],
    [405, { detail: 'Method Not Allowed' }, 'signin_upstream_error'],
    [200, '<html><div id="captcha-element"></div></html>', 'signin_verification_required'],
    [401, { detail: 'Unauthorized' }, 'signin_rejected'],
    [200, { unexpected: true }, 'signin_upstream_error']
  ]) {
    const failure = SigninError.fromResponse({ status, data })
    assert.equal(failure.code, code)
    assert.equal(failure.upstreamStatus, status)
  }
  assert.equal(SigninError.fromError({ request: {} }).code, 'signin_transport_error')
})

test('manual add and refresh report a real upstream block without saving, retrying or logging the Axios object', async t => {
  await accountManager._initPromise
  const saved = { email: 'saved@example.invalid', password: 'fixture', token: 'old-test-value' }
  accountManager.accountTokens = [saved]
  const secretMarker = 'private-fixture-marker'
  const calls = t.mock.method(axios, 'post', async () => {
    throw Object.assign(new Error(secretMarker), {
      config: { data: secretMarker },
      response: { status: 405, data: blockPage + secretMarker }
    })
  })
  const logs = t.mock.method(logger, 'error', () => {})
  const save = t.mock.method(accountManager.dataPersistence, 'saveAccount', () => {
    throw new Error('unexpected write')
  })
  const app = express()
  app.use(express.json(), routes)
  const server = app.listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    accountManager.destroy()
  })
  await once(server, 'listening')
  for (const [route, body] of [
    ['setAccount', { email: 'new@example.invalid', password: 'fixture' }],
    ['refreshAccount', { email: saved.email }]
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify(body)
    })
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: 'Qwen security blocked sign-in.', code: 'signin_waf_block', upstreamStatus: 405
    })
  }
  assert.equal(calls.mock.callCount(), 2)
  assert.equal(await accountManager.refreshAccountToken(saved.email), false)
  assert.equal(save.mock.callCount(), 0)
  assert.equal(accountManager.accountTokens[0], saved)
  assert.equal(logs.mock.callCount(), 3)
  for (const call of logs.mock.calls) {
    assert.deepEqual(call.arguments, ['Qwen signin: signin_waf_block (upstream HTTP 405)', 'AUTH'])
  }
})
