// Where a picture is uploaded from and where its chat is made: one account for the
// whole request (Qwen2API-fjk).
//
// The rotator hands every call its least recently used account and records the use
// (src/utils/account-rotator.js#_selectLeastUsedAccount). With one account nothing shows.
// With two, a call for the upload and a call for the chat were two accounts: the picture
// went up from one account's page, into that account's store, and the chat was made on
// another's — which is not told to look there. The model would not see the picture, and
// no error would say so.
//
// Driven here with two accounts behind the real rotator, the middleware and the
// controllers as they are, and what leaves the process answered by the test: the upload,
// the chat request and the generation. The last stretch — from the upload to its STS call
// leaving from that account's page — is tests/browser-egress.test.js (Qwen2API-03v,
// Qwen2API-3ue.12). The signature for an account with a proxy is tests/upload-proxy-v4.test.js.
//
// Same header as tests/client-gone.test.js: without API_KEY the startup cuts the process
// before the runner reports, and without DATA_SAVE_MODE=none account.js would try a real
// login on import. The origins are a closed loopback port: nothing here can leave.
process.env.QWEN_CHAT_PROXY_URL = 'http://127.0.0.1:9'
process.env.QWEN_CLI_PROXY_URL = 'http://127.0.0.1:9'
process.env.API_KEY = 'upload-account-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = false
process.env.PROXY_URL = ''

const { test, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')

const accountManager = require('../src/utils/account')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const AccountRotator = require('../src/utils/account-rotator')
const axios = require('axios')
const uploadModule = require('../src/utils/upload.js')
const requestModule = require('../src/utils/request.js')
const browserEgress = require('../src/utils/browser-egress.js')
const config = require('../src/config')

// The controllers capture these when they are first required: the stubs go in before,
// stay for the whole file, and each test reads what they were asked.
let uploads = []
let chats = []
let sent = []
let generations = []
uploadModule.uploadFileToQwenOss = async (buffer, filename, token, account) => {
  uploads.push({ account, filename, bytes: buffer.length })
  return { status: 200, file_url: `https://files.example.invalid/${uploads.length}.png`, file_id: `file-${uploads.length}` }
}
requestModule.generateChatID = async (token, model, account) => {
  chats.push(account)
  return 'chat-upload-account'
}
requestModule.sendChatRequest = async (body, options) => {
  sent.push({ body, options })
  return { status: false, response: null }
}

const { processRequestBody } = require('../src/middlewares/chat-middleware.js')
const { handleChatCompletion } = require('../src/controllers/chat.js')
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')
const { imgCacheManager } = require('../src/utils/chat-helpers.js')
const { handleImageVideoCompletion, handleOpenAIImagesEdit } = require('../src/controllers/chat.image.video.js')

const MODEL = 'qwen-upload-account'
// Named as the application tells the edit path by (utils/chat-helpers.js#isChatType).
const EDIT_MODEL = `${MODEL}-image-edit`
// The two accounts of the request, as the rotator holds them.
let FIRST
let SECOND
// A picture the cache has never seen: one more, each time asked for.
let pictures = 0
const picture = () => `data:image/png;base64,${Buffer.from(`picture ${++pictures}`).toString('base64')}`
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const IMAGE_URL = 'https://cdn.example.com/a.png'

/**
 * A request as the handlers get it from Express, and the ways its client can go
 * (tests/client-gone.test.js).
 */
const liveRequest = (extra = {}) => {
  let address = { address: '127.0.0.1', family: 'IPv4', port: 42424 }
  const socket = Object.assign(new EventEmitter(), { destroyed: false, address: () => address })
  const req = Object.assign(new EventEmitter(), { socket, aborted: false }, extra)
  req.leave = () => { address = null }
  return req
}

/**
 * A response that says only what Bun says — as in tests/client-gone.test.js.
 */
const bunResponse = () => ({
  output: '',
  body: null,
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers, value) {
    if (typeof headers === 'string') this.headers[headers] = value
    else Object.assign(this.headers, headers)
    return this
  },
  status(code) { this.statusCode = code; return this },
  write(chunk) { this.headersSent = true; this.output += chunk; return true },
  end(chunk = '') {
    if (chunk) this.output += chunk
    this.writableEnded = true
  },
  json(payload) {
    this.body = payload
    this.output = JSON.stringify(payload)
    this.headersSent = true
    this.writableEnded = true
    return this
  }
})

/** The request through the middleware of /v1/chat/completions, as the route has it. */
const throughMiddleware = async requestBody => {
  const req = liveRequest({ body: requestBody })
  const res = bunResponse()
  let passed = false
  await processRequestBody(req, res, () => { passed = true })
  assert.equal(passed, true, `the middleware let the request through: ${res.output}`)
  return { req, res }
}

test.before(async () => {
  await accountManager._initPromise
  // qwen.ai is never contacted: a direct call only goes where a test says it may.
  const realPost = axios.post
  const realGet = axios.get
  axios.post = async url => { throw new Error(`offline test: no direct POST to ${url}`) }
  axios.get = async url => { throw new Error(`offline test: no direct GET to ${url}`) }
  const realCompletions = browserEgress.postCompletions
  const realPageAnswer = browserEgress.egressJson
  browserEgress.postCompletions = async context => {
    generations.push(context)
    const stream = new Readable({ read() {} })
    stream.push(frame({ choices: [{ delta: { phase: 'image_gen', content: `![image](${IMAGE_URL})` } }] }))
    stream.push(null)
    return { status: 200, statusText: 'OK', headers: {}, data: stream }
  }
  browserEgress.egressJson = async context => { throw new Error(`offline test: no whole-answer call to ${context.url}`) }
  test.after(() => {
    axios.post = realPost
    axios.get = realGet
    browserEgress.postCompletions = realCompletions
    browserEgress.egressJson = realPageAnswer
    accountManager.destroy()
  })
})

test.beforeEach(() => {
  FIRST = { email: 'first@example.invalid', token: 'upload-account-first-token' }
  SECOND = { email: 'second@example.invalid', token: 'upload-account-second-token' }
  accountManager.accountRotator = new AccountRotator()
  accountManager.accountRotator.setAccounts([FIRST, SECOND])
  accountManager.accountTokens = [FIRST, SECOND]
  accountManager.isInitialized = true
  uploads = []
  chats = []
  sent = []
  generations = []
  imgCacheManager.clear()
  // Through the page, as on prod: the generation is the page's own fetch.
  config.chatCreationTransport = 'browser'
  config.completionsTransport = 'browser'
})

describe('why: an account asked for twice is two accounts', () => {
  it('the rotator hands two calls two accounts — the least recently used one, each time', () => {
    assert.equal(accountManager.getAccount(), FIRST)
    assert.equal(accountManager.getAccount(), SECOND)
    assert.equal(accountManager.getAccount(), FIRST)
  })
})

describe('/v1/chat/completions: a picture in the message', () => {
  const withPicture = content => ({ model: MODEL, messages: [{ role: 'user', content }] })

  it('is uploaded on the account the chat is then made on', async () => {
    const { req, res } = await throughMiddleware(withPicture([
      { type: 'text', text: 'What is on it?' },
      { type: 'image_url', image_url: { url: picture() } }
    ]))

    await handleChatCompletion(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email], 'uploaded once')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].options.currentAccount, FIRST, 'the chat is made on the account the picture was uploaded from')
  })

  it('two pictures: both on that one account, and the chat on it', async () => {
    const { req, res } = await throughMiddleware(withPicture([
      { type: 'image_url', image_url: { url: picture() } },
      { type: 'text', text: 'What is on them?' },
      { type: 'image_url', image_url: { url: picture() } }
    ]))

    await handleChatCompletion(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email, FIRST.email])
    assert.equal(sent[0].options.currentAccount, FIRST)
  })

  it('in a conversation: the picture of the last message is uploaded on the account its chat is made on', async () => {
    const { req, res } = await throughMiddleware({ model: MODEL, messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hello — what shall we look at?' },
      {
        role: 'user', content: [
          { type: 'image_url', image_url: { url: picture() } },
          { type: 'text', text: 'What is on it?' }
        ]
      }
    ] })

    await handleChatCompletion(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email])
    assert.equal(sent[0].options.currentAccount, FIRST)
  })

  it('an edit, where the controller picks its account itself: the generation is made on the account of the upload', async () => {
    const { req, res } = await throughMiddleware({ model: EDIT_MODEL, messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: picture() } }, { type: 'text', text: 'Make it red' }] }
    ] })

    await handleImageVideoCompletion(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email])
    assert.equal(chats[0], FIRST, 'the chat is created on the account the picture was uploaded from')
    assert.equal(generations[0].account, FIRST, 'and the generation leaves from its page')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  })
})

describe('a request that uploads nothing chooses its account as it always did', () => {
  it('text only: no account is named for the chat', async () => {
    const { req, res } = await throughMiddleware({ model: MODEL, messages: [{ role: 'user', content: 'Say pong.' }] })

    await handleChatCompletion(req, res)

    assert.deepEqual(uploads, [])
    assert.equal('currentAccount' in sent[0].options, false, 'sendChatRequest takes the account itself, as before')
  })

  it('a picture given by its link: nothing is uploaded, no account is named', async () => {
    const { req, res } = await throughMiddleware({ model: MODEL, messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
      { type: 'text', text: 'What is on it?' }
    ] }] })

    await handleChatCompletion(req, res)

    assert.deepEqual(uploads, [])
    assert.equal(req.upload_account, null)
    assert.equal('currentAccount' in sent[0].options, false)
  })
})

describe('/v1/messages: a picture in the message', () => {
  it('is uploaded on the account the chat is then made on', async () => {
    const req = liveRequest({ body: { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('anthropic picture').toString('base64') } },
      { type: 'text', text: 'What is on it?' }
    ] }] } })
    const res = bunResponse()

    await handleAnthropicMessages(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email])
    assert.equal(sent.length, 1)
    assert.equal(sent[0].options.currentAccount, FIRST, 'the chat is made on the account the picture was uploaded from')
  })
})

describe('/v1/images/edits: the picture to edit', () => {
  it('given inline: uploaded on the account the generation is then made on', async () => {
    const req = liveRequest({ body: { model: MODEL, prompt: 'Make it red', image: picture() } })
    const res = bunResponse()

    await handleOpenAIImagesEdit(req, res)

    assert.deepEqual(uploads.map(call => call.account.email), [FIRST.email])
    assert.equal(chats[0], FIRST, 'the chat is created on the account the picture was uploaded from')
    assert.equal(generations[0].account, FIRST, 'and the generation leaves from its page')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  })

  // A file as the route's upload middleware hands it over (multer): the bytes in memory, the field named.
  const uploadedFile = name => ({ fieldname: 'image', originalname: name, buffer: Buffer.from(`the bytes of ${name}`) })

  it('given as an uploaded file: uploaded on the account the generation is then made on', async () => {
    const req = liveRequest({ body: { model: MODEL, prompt: 'Make it red' }, files: [uploadedFile('a.png')] })
    const res = bunResponse()

    await handleOpenAIImagesEdit(req, res)

    assert.deepEqual(uploads.map(call => [call.account.email, call.filename]), [[FIRST.email, 'a.png']])
    assert.equal(chats[0], FIRST)
    assert.equal(generations[0].account, FIRST)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  })

  it('two uploaded files and an inline one: all on that one account', async () => {
    const req = liveRequest({
      body: { model: MODEL, prompt: 'Make it red', image: picture() },
      files: [uploadedFile('a.png'), { ...uploadedFile('b.png'), fieldname: 'other' }, uploadedFile('c.png')]
    })
    const res = bunResponse()

    await handleOpenAIImagesEdit(req, res)

    // The file of another field is not the picture to edit: it is not uploaded.
    assert.deepEqual(uploads.map(call => call.filename), ['a.png', 'c.png', 'upload.png'])
    assert.deepEqual([...new Set(uploads.map(call => call.account.email))], [FIRST.email])
    assert.equal(generations[0].account, FIRST)
  })

  it('given by its link: nothing is uploaded, and the generation takes the account itself', async () => {
    const req = liveRequest({ body: { model: MODEL, prompt: 'Make it red', image: 'https://cdn.example.com/src.png' } })
    const res = bunResponse()

    await handleOpenAIImagesEdit(req, res)

    assert.deepEqual(uploads, [])
    assert.equal(chats[0], FIRST)
    assert.equal(generations[0].account, FIRST)
  })
})
