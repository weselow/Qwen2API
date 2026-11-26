// How the list of models is fetched (src/models/models-map.js#getLatestModels) — with a
// bound on qwen.ai's time (Qwen2API-0a4).
//
// The call went out without a timeout. During the dead-proxy incident of 2026-11-19 every
// refresh that found the cache expired hung for the whole of the transport's own headers
// timeout (300 s) and silently served the stale cache: /v1/models answered in 50 ms from
// cache while the upstream was dead, and nothing said so for five minutes at a time.
//
// tests/model-map.test.js is the resolver's (src/utils/model-map.js): it stubs this module
// whole and never lets account.js load. This file is the fetch itself, with the module as it
// is, the account manager as it is, and axios replaced by a stand-in that keeps to the
// timeout it is given — or, given none, stays silent as long as a dead upstream does.
//
// The module keeps its cache from call to call and has no way to drop it, so the tests run
// in the order written: nothing cached, then a list, then a dead upstream under it.
//
// Same header as tests/client-gone.test.js: without API_KEY the startup cuts the process
// before the runner reports, and without DATA_SAVE_MODE=none account.js would try a real
// login on import.
process.env.API_KEY = 'models-map-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const { test, describe, it } = require('node:test')
const assert = require('node:assert/strict')

const accountManager = require('../src/utils/account')
const axios = require('axios')
const { logger } = require('../src/utils/logger')
const modelsMap = require('../src/models/models-map.js')

const ACCOUNT = { email: 'models-map@example.invalid', token: 'models-map-test-token' }
const LIST = [{ id: 'qwen3-max' }, { id: 'qwen3.8-max' }]
// What a dead upstream is: no answer for as long as anyone waits.
const DEAD_MS = 60 * 1000
// How long a test waits for a call that should have come back at once.
const SOON = { timeout: 5000 }

let asked
let answers
let errors
const realGet = axios.get

/**
 * axios.get as axios is about the timeout: a call answered as the script says, or — given
 * no timeout — left hanging as long as a dead upstream leaves it.
 */
const standIn = async (url, requestConfig) => {
    asked.push({ url, requestConfig })
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer === 'dead') {
        return new Promise((resolve, reject) => {
            const ms = requestConfig.timeout > 0 ? Math.min(requestConfig.timeout, 20) : DEAD_MS
            const timer = setTimeout(() => {
                reject(Object.assign(new Error(`timeout of ${requestConfig.timeout}ms exceeded`), { code: 'ECONNABORTED' }))
            }, ms)
            timer.unref?.()
        })
    }
    if (answer instanceof Error) throw answer
    return answer
}

test.before(async () => {
    await accountManager._initPromise
    accountManager.getAccount = () => ACCOUNT
    axios.get = standIn
})
test.beforeEach(() => {
    asked = []
    errors = []
})
test.after(() => {
    axios.get = realGet
    accountManager.destroy()
})

describe('the list of models, fetched', () => {
  it('nothing cached and the upstream dead: an empty list, and the failure said at once', SOON, async context => {
    context.mock.method(logger, 'error', (...args) => errors.push(args))
    answers = ['dead']

    const started = Date.now()
    const models = await modelsMap.getLatestModels(true)

    assert.deepEqual(models, [])
    assert.equal(errors.length, 1, 'the failure is in the log')
    assert.match(String(errors[0][0]), /获取模型列表失败/)
    assert.ok(Date.now() - started < 3000, 'said within seconds, not held for the transport\'s 300')
    assert.equal(asked.length, 1)
  })

  it('answered: the list, taken once and kept', async () => {
    answers = [{ data: { data: LIST } }]

    assert.deepEqual(await modelsMap.getLatestModels(true), LIST)
    assert.deepEqual(await modelsMap.getLatestModels(), LIST)

    assert.equal(asked.length, 1, 'the cache answers the second call')
    assert.match(asked[0].url, /\/api\/models$/)
  })

  it('the call carries a bound of its own: fifteen seconds, whatever the transport allows', async () => {
    answers = [{ data: { data: LIST } }]

    await modelsMap.getLatestModels(true)

    assert.equal(asked[0].requestConfig.timeout, 15 * 1000)
  })

  it('the upstream dead under a cached list: the stale list is served, the failure is logged, and at once',
    SOON, async context => {
      context.mock.method(logger, 'error', (...args) => errors.push(args))
      answers = ['dead']
      const started = Date.now()

      const models = await modelsMap.getLatestModels(true)

      assert.deepEqual(models, LIST, 'the stale cache, as before')
      assert.equal(errors.length, 1)
      assert.match(String(errors[0][0]), /获取模型列表失败/)
      assert.match(String(errors[0][0]), /ECONNABORTED|timeout/, 'and it is named a timeout')
      assert.ok(Date.now() - started < 3000)
    })

  it('after a failed refresh the cache counts as fresh: the next call is not another attempt', SOON, async () => {
    // The call that just failed is the one before; the module stamped the cache as of then.
    const models = await modelsMap.getLatestModels()

    assert.deepEqual(models, LIST)
    assert.equal(asked.length, 0, 'no second attempt at once — the TTL decides, as before')
  })
})
