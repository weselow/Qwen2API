const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const axios = require('axios')

Object.assign(process.env, {
  API_KEY: 'chat-create-test-key', DATA_SAVE_MODE: 'none', ACCOUNTS: '',
  ENABLE_CLI: 'false', ENABLE_FILE_LOG: 'false', PROXY_URL: '', CHAT_RETRY_COUNT: '3'
})
const modelsMap = require('../src/models/models-map')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const accountManager = require('../src/utils/account')
const { logger } = require('../src/utils/logger')
const { generateChatID, sendChatRequest } = require('../src/utils/request')
const { ChatCreationError, resetChatChallengeBreaker } = require('../src/utils/upstream-error')
const { handleChatCompletion } = require('../src/controllers/chat')
const { handleAnthropicMessages } = require('../src/controllers/anthropic')
const {
  handleImageVideoCompletion, handleOpenAIImagesGeneration, handleOpenAIImagesEdit,
  handleOpenAIVideoGeneration
} = require('../src/controllers/chat.image.video')

const SECRET = 'PRIVATE_FIXTURE_MUST_NOT_ESCAPE'
const ACCOUNT = { email: 'synthetic@example.invalid', token: SECRET }
const BODY = { model: 'qwen3-max', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
const fixtures = [
  ['unauthorized', { success: false, data: { code: 'unauthorized', details: SECRET } }, 'upstream_session_unauthorized', 502],
  ['WAF HTML', `<html><meta name="aliyun_waf_aa" content="${SECRET}"></html>`, 'upstream_waf_challenge', 503],
  ['unrelated HTML', `<html><title>Help with captcha</title><body>${SECRET}</body></html>`, 'upstream_invalid_response', 502],
  ['unknown JSON error', { success: false, data: { code: SECRET, message: SECRET } }, 'upstream_invalid_response', 502],
  ['transport error', null, 'upstream_transport_error', 503]
]
const originalPost = axios.post
const originalGet = axios.get
const originalGetAccount = accountManager.getAccount
const originalLog = logger.error
let calls = []
let logs = []
let selected

const response = () => ({
  headers: {}, headersSent: false, writableEnded: false, statusCode: 200, output: '',
  set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this },
  setHeader(key, value) { this.headers[key] = value },
  status(value) { this.statusCode = value; return this },
  json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this },
  write(chunk) { this.headersSent = true; this.output += chunk; return true },
  end(chunk = '') { this.output += chunk; this.writableEnded = true },
  on() { return this }
})

const unsafeTransportError = () => Object.assign(new Error(SECRET), {
  code: 'ECONNRESET', config: { headers: { Authorization: SECRET, Cookie: SECRET }, proxy: SECRET }
})

const noLeaksOrRetries = (res) => {
  assert.equal(calls.length, 1, 'no generation, login, refresh, failover or retry after chat creation fails')
  assert.ok(calls[0].endsWith('/api/v2/chats/new'))
  assert.doesNotMatch(JSON.stringify({ res, logs }), new RegExp(SECRET))
  assert.ok(logs.some(args => String(args[0]).includes(`category=${selected[2]}`)), 'safe log retains the category')
}

test.before(async () => {
  await accountManager._initPromise
  accountManager.getAccount = () => ACCOUNT
  axios.get = async () => assert.fail('no real GET requests allowed')
  logger.error = (...args) => logs.push(args)
})
test.beforeEach(() => {
  resetChatChallengeBreaker()
  calls = []
  logs = []
  axios.post = async (url) => {
    calls.push(url)
    assert.equal(calls.length, 1, 'no retry allowed')
    if (selected[0] === 'transport error') throw unsafeTransportError()
    return { status: 200, data: selected[1], headers: { 'content-type': typeof selected[1] === 'string' ? 'text/html' : 'application/json', 'set-cookie': SECRET } }
  }
})
test.after(() => {
  axios.post = originalPost
  axios.get = originalGet
  accountManager.getAccount = originalGetAccount
  logger.error = originalLog
  accountManager.destroy()
})

test('generateChatID returns a valid data.id', async () => {
  selected = ['valid', { success: true, data: { id: 'synthetic-chat' } }]
  assert.equal(await generateChatID(SECRET, BODY.model, ACCOUNT), 'synthetic-chat')
  assert.equal(calls.length, 1)
  assert.deepEqual(logs, [])
})

for (const fixture of fixtures) {
  test(`generateChatID: ${fixture[0]} throws a safe typed category`, async () => {
    selected = fixture
    await assert.rejects(generateChatID(SECRET, BODY.model, ACCOUNT), error => {
      assert.ok(error instanceof ChatCreationError)
      assert.equal(error.code, fixture[2])
      assert.equal(error.status, fixture[3])
      assert.equal(error.response, undefined)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET))
      return true
    })
    noLeaksOrRetries(null)
  })
  test(`sendChatRequest: ${fixture[0]} preserves the cause before generation`, async () => {
    selected = fixture
    await assert.rejects(sendChatRequest(BODY, { currentAccount: ACCOUNT }), { code: fixture[2] })
    noLeaksOrRetries(null)
  })
  for (const stream of [false, true]) {
    for (const hasTools of [false, true]) {
      for (const [name, handler] of [['OpenAI', handleChatCompletion], ['Anthropic', handleAnthropicMessages]]) {
        test(`${name} stream=${stream} tools=${hasTools}: ${fixture[0]} reaches client`, async () => {
          selected = fixture
          const res = response()
          const body = { ...BODY, stream }
          if (hasTools) body.tools = name === 'OpenAI'
            ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }]
            : [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }]
          await handler({ body, has_tools: hasTools, allowed_tool_names: ['lookup'] }, res)
          assert.equal(res.statusCode, fixture[3])
          assert.equal(res.body.error.code, fixture[2])
          assert.notEqual(res.body.error.type, 'authentication_error')
          assert.equal(res.headers['Retry-After'], undefined)
          assert.equal(res.output, '', 'no successful SSE emitted')
          noLeaksOrRetries(res)
        })
      }
    }
    for (const chatType of ['t2i', 'image_edit', 't2v']) {
      test(`media ${chatType} stream=${stream}: ${fixture[0]} reaches client`, async () => {
        selected = fixture
        const res = response()
        await handleImageVideoCompletion({ body: { ...BODY, chat_type: chatType, stream } }, res)
        assert.equal(res.statusCode, fixture[3])
        assert.equal(res.body.code, fixture[2])
        assert.equal(res.headers['Retry-After'], undefined)
        assert.equal(res.output, '')
        noLeaksOrRetries(res)
      })
    }
  }
}

for (const fixture of fixtures.slice(0, 2)) {
  for (const [name, handler] of [
    ['images/generations', handleOpenAIImagesGeneration], ['images/edits', handleOpenAIImagesEdit],
    ['videos', handleOpenAIVideoGeneration]
  ]) {
    test(`${name}: ${fixture[0]} preserves category`, async () => {
      selected = fixture
      const res = response()
      await handler({ body: { model: BODY.model, prompt: 'hello', image: 'https://example.invalid/image.png' } }, res)
      assert.equal(res.statusCode, fixture[3])
      assert.equal(res.body.error.code, fixture[2])
      noLeaksOrRetries(res)
    })
  }
  test(`video already sent keep-alive: ${fixture[0]} is an SSE error`, async (t) => {
    selected = fixture
    t.mock.timers.enable({ apis: ['setInterval'] })
    let reject
    axios.post = async url => { calls.push(url); return new Promise((resolve, rejectRequest) => { reject = rejectRequest }) }
    const res = response()
    const done = handleImageVideoCompletion({ body: { ...BODY, stream: true, chat_type: 't2v' } }, res)
    t.mock.timers.tick(15000)
    reject(Object.assign(unsafeTransportError(), { response: { status: 403, data: fixture[1] } }))
    await done
    assert.equal(res.statusCode, 200, 'committed status cannot be changed')
    const payload = JSON.parse(res.output.split('\n').find(line => line.startsWith('data: {')).slice(6))
    assert.equal(payload.error.code, fixture[2])
    assert.equal(payload.choices, undefined)
    assert.ok(res.output.endsWith('data: [DONE]\n\n'))
    noLeaksOrRetries(res)
  })
}

for (const payload of [
  { success: false, code: 'unauthorized' },
  { success: false, error: { code: 'unauthorized', message: SECRET } },
  { success: false, data: { id: 'stale-id', code: 'unauthorized' } }
]) {
  test(`confirmed unauthorized envelope ${JSON.stringify(payload)} never accepts a stale ID`, async () => {
    selected = ['unauthorized', payload, 'upstream_session_unauthorized']
    await assert.rejects(generateChatID(SECRET, BODY.model, ACCOUNT), { code: selected[2] })
    noLeaksOrRetries(null)
  })
}

test('a word unauthorized without the confirmed envelope remains unclassified', async () => {
  selected = ['unknown', { message: 'unauthorized', data: { code: 'unauthorized' } }, 'upstream_invalid_response']
  await assert.rejects(generateChatID(SECRET, BODY.model, ACCOUNT), { code: selected[2] })
  noLeaksOrRetries(null)
})

test('successful sendChatRequest still starts exactly one synthetic generation', async () => {
  axios.post = async url => {
    calls.push(url)
    return url.endsWith('/chats/new')
      ? { status: 200, data: { data: { id: 'synthetic-chat' } } }
      : { status: 200, headers: {}, data: Readable.from(['data: [DONE]\n\n']) }
  }
  const result = await sendChatRequest(BODY, { currentAccount: ACCOUNT })
  assert.equal(result.status, true)
  assert.equal(result.chatId, 'synthetic-chat')
  assert.equal(calls.length, 2)
  result.response.destroy()
})
