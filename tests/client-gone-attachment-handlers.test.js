const test = require('node:test')
const assert = require('node:assert/strict')

// The handlers of /v1/chat/completions and of the Anthropic route when a
// client goes away while a file is being attached to its request
// (Qwen2API-4l1): the going ends the request where it stands — in the
// middleware, while the pictures are uploaded, or in the controller, before
// the completions call — and is no error: nothing is said of it, and no
// answer is built for a client that is gone. What ends it is ClientGoneError
// (utils/client-gone.js); it is thrown here where the handlers take it, at
// the seams they read once — parserMessages and sendChatRequest — so the
// files themselves (tests/client-gone-attachment.test.js) are not driven again.
process.env.API_KEY = 'client-gone-attachment-handlers-test'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }

// Both read their seam by destructuring at their first require: the double has to be in place before.
const chatHelpers = require('../src/utils/chat-helpers.js')
const realParsing = chatHelpers.parserMessages
let parsing = async () => []
chatHelpers.parserMessages = (...args) => parsing(...args)
const requestModule = require('../src/utils/request.js')
let sending = async () => ({ status: false, response: null })
requestModule.sendChatRequest = (...args) => sending(...args)

const { processRequestBody } = require('../src/middlewares/chat-middleware.js')
const { handleChatCompletion } = require('../src/controllers/chat.js')
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')
const { ClientGoneError } = require('../src/utils/client-gone.js')
const { logger } = require('../src/utils/logger')

test.after(() => require('../src/utils/account.js').destroy())

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false, writableEnded: false }
  res.status = (code) => { res.statusCode = code; return res }
  res.set = (key, value) => {
    if (key && typeof key === 'object') Object.assign(res.headers, key)
    else res.headers[key] = value
    return res
  }
  res.json = (body) => { res.body = body; res.headersSent = true; res.writableEnded = true; return res }
  res.write = () => true
  res.end = () => { res.writableEnded = true }
  res.flushHeaders = () => { res.headersSent = true }
  res.removeHeader = (name) => { delete res.headers[name] }
  res.on = () => res
  return res
}

const request = () => ({
  body: { model: 'qwen3-max', stream: false, messages: [{ role: 'user', content: 'hola' }] },
  has_tools: false,
  allowed_tool_names: []
})

// What the app says while a test runs.
function said(t) {
  const lines = []
  const saved = logger.error
  logger.error = (...args) => lines.push(args.map(String).join(' '))
  t.after(() => { logger.error = saved })
  return lines
}

test('the middleware: gone while the request’s pictures were being uploaded — nothing is said, and no answer is made', async t => {
  const lines = said(t)
  parsing = async () => { throw new ClientGoneError() }
  const res = fakeRes()
  let passed = false
  await processRequestBody(request(), res, () => { passed = true })
  assert.deepEqual([lines, res.statusCode, res.body, res.headersSent, passed], [[], 200, null, false, false])
})

test('the middleware hands the client to parserMessages, which uploads the request’s pictures', async t => {
  const seen = []
  parsing = async (...args) => { seen.push(args); return [] }
  await processRequestBody(request(), fakeRes(), () => {})
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0][4]?.gone, 'function', 'what watchClient(req) returns')
  assert.equal(seen[0][4].gone(), false, 'a request without a socket to ask is a client that stays')
})

test('the middleware: any other failure while the body is prepared is said and answered, as before', async t => {
  const lines = said(t)
  parsing = async () => { throw new Error('the parse broke') }
  const res = fakeRes()
  await processRequestBody(request(), res, () => {})
  assert.equal(lines.length, 1)
  assert.match(lines[0], /the parse broke/)
  assert.equal(res.statusCode, 500)
})

test('the controller: gone while the chat was being made, or the context attached — nothing is said, and no answer is made', async t => {
  const lines = said(t)
  sending = async () => { throw new ClientGoneError() }
  const res = fakeRes()
  await handleChatCompletion(request(), res)
  assert.deepEqual([lines, res.statusCode, res.body, res.headersSent], [[], 200, null, false])
})

test('the Anthropic route: the client is handed to parserMessages and to sendChatRequest, and its going is said by nobody', async t => {
  // Its own preparing of the body runs for real: a text request uploads nothing.
  const prepared = []
  parsing = (...args) => { prepared.push(args); return realParsing(...args) }
  const seen = []
  sending = async (body, options) => { seen.push(options); throw new ClientGoneError() }
  const lines = said(t)
  const res = fakeRes()
  await handleAnthropicMessages({
    body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
  }, res)
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0].client?.gone, 'function', 'what watchClient(req) returns')
  assert.equal(typeof prepared[0]?.[4]?.gone, 'function', 'the pictures of the request are uploaded under the same watch')
  assert.deepEqual([lines, res.statusCode, res.body], [[], 200, null])
})

test('the Anthropic route: gone while the request’s pictures were being uploaded — nothing is said, and no answer is made', async t => {
  parsing = async () => { throw new ClientGoneError() }
  sending = async () => { throw new Error('the request went on after its client left') }
  const lines = said(t)
  const res = fakeRes()
  await handleAnthropicMessages({
    body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
  }, res)
  assert.deepEqual([lines, res.statusCode, res.body, res.headersSent], [[], 200, null, false])
})

test('the controller: the client is handed to sendChatRequest with the request’s options', async t => {
  const seen = []
  sending = async (body, options) => { seen.push(options); return { status: false, response: null, message: 'no' } }
  await handleChatCompletion(request(), fakeRes())
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0].client?.gone, 'function', 'what watchClient(req) returns')
  assert.equal(seen[0].client.gone(), false, 'a request without a socket to ask is a client that stays')
})

test('the controller: any other failure of the request is said and answered, as before', async t => {
  const lines = said(t)
  sending = async () => { throw new Error('the chat broke') }
  const res = fakeRes()
  await handleChatCompletion(request(), res)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /the chat broke/)
  assert.equal(res.statusCode, 500)
})
