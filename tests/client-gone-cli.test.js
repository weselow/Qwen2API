// A client that goes away takes its upstream with it on the CLI path too
// (Qwen2API-3ue.10) — the same signal, and the same rule, as on the text paths
// (tests/client-gone.test.js, Qwen2API-mxs) and on the paths of images and video
// (tests/client-gone-media.test.js): the request and its socket, never the
// response, because under Bun — the runtime of prod — the response says nothing
// when its client leaves.
//
// The CLI upstream is not behind the worker's relay: the stream is closed where
// it is read, and the call itself is cancelled from the moment it is made — so
// that a client leaving while the upstream has not answered yet does not leave a
// call open for the ten minutes of its timeout, in the JSON answer as much as in
// the stream.
//
// The CLI upstream here is a stand-in on 127.0.0.1, watching its own side of the
// connection: nothing else can show the application hanging up.
//
// Same header as tests/client-gone.test.js: without API_KEY the startup cuts the
// process before the runner reports, and without DATA_SAVE_MODE=none account.js
// would try a real login on import.
process.env.API_KEY = 'client-gone-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const { test, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')

const accountManager = require('../src/utils/account')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const { logger } = require('../src/utils/logger')
const config = require('../src/config')
const { handleCliChatCompletion } = require('../src/controllers/cli.chat.js')

const EMAIL = 'client-gone-cli@example.invalid'
// An account as the CLI route hands it to the controller (src/routes/cli.chat.js).
const ACCOUNT = { email: EMAIL, token: 'cli-test-token', cli_info: { access_token: 'cli-access-token', request_number: 0 } }
const MESSAGE = { role: 'user', content: 'Say pong' }
const streamed = () => ({ model: 'cli-test', stream: true, messages: [MESSAGE] })
const whole = () => ({ model: 'cli-test', stream: false, messages: [MESSAGE] })
// Long enough for a loaded CI runner, short enough that a read that was never
// closed fails the test instead of hanging it.
const HELD = { timeout: 10000 }
// An upstream that has not answered yet, and a client that leaves: the request
// must end long before the call's ten-minute timeout.
const SOON = { timeout: 3000 }
// How long an answer in progress takes to run out: far longer than a test waits.
const LONG_ANSWER = { frames: 80, everyMs: 100 }

const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const word = () => sse({ id: 'c', object: 'chat.completion.chunk', model: 'cli-test', choices: [{ index: 0, delta: { content: 'word ' }, finish_reason: null }] })
const DONE = 'data: [DONE]\n\n'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A request as the controller gets it from Express, and the ways its client can go —
 * each what a runtime was measured doing with a body express.json read
 * (tests/client-gone.test.js):
 *
 *   leave()            — Bun 1.3.14: no event, no flag; the socket loses its address,
 *                        and that is all.
 *   leave('events')    — Node: 'end' and 'close' on the socket, `socket.destroyed` true.
 */
const liveRequest = (extra = {}) => {
  let address = { address: '127.0.0.1', family: 'IPv4', port: 42424 }
  const socket = Object.assign(new EventEmitter(), { destroyed: false, address: () => address })
  const req = Object.assign(new EventEmitter(), { socket, aborted: false }, extra)
  req.leave = (how = 'address') => {
    address = null
    if (how !== 'events') return
    address = { address: undefined, family: undefined, port: undefined }
    socket.destroyed = true
    socket.emit('end')
    socket.emit('close')
  }
  return req
}

/**
 * A response that says only what Bun says: `destroyed` never turns true, and
 * `write` keeps returning true after the client left.
 */
const bunResponse = () => ({
  output: '',
  body: null,
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  setHeader(name, value) { this.headers[name] = value; return this },
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
  },
  status(code) { this.statusCode = code; return this }
})

/** What a gone client must not cost: an error line, a failure or a usage on the account. */
const recorded = (context, object, name) => {
  const calls = []
  context.mock.method(object, name, (...args) => calls.push(args))
  return calls
}
const until = async (condition, what) => {
  for (let waited = 0; !condition() && waited < 2000; waited += 5) {
    await delay(5)
  }
  assert.ok(condition(), `not within 2 s: ${what}`)
}

/**
 * The CLI upstream as a stand-in on 127.0.0.1: one plan per test, and a record
 * of every call — above all when the application hung up on it.
 */
const cliUpstream = () => {
  const calls = []
  let plan = 'short'
  const PLANS = {
    // A short answer: one frame, and done.
    short: (request, response, record) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      record.sent += 1
      response.write(word())
      response.end(DONE)
      record.endedAt = Date.now()
    },
    // An answer in progress: a frame every so often, for a good while.
    long: async (request, response, record) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(word())
      record.sent += 1
      for (let i = 0; i < LONG_ANSWER.frames; i++) {
        await delay(LONG_ANSWER.everyMs)
        if (response.destroyed) return
        response.write(word())
        record.sent += 1
      }
      response.end(DONE)
      record.endedAt = Date.now()
    },
    // The upstream has not answered yet.
    silent: () => {},
    // The whole answer as JSON.
    whole: (request, response, record) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'c', object: 'chat.completion', model: 'cli-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 }
      }))
      record.endedAt = Date.now()
    },
    // The road broke under a client that stayed.
    broken: request => { request.socket.destroy() }
  }
  const server = http.createServer((request, response) => {
    const record = { url: request.url, authorization: request.headers.authorization, sent: 0, closedAt: null, endedAt: null }
    calls.push(record)
    // The application hanging up: its side of the connection going is this side's closing.
    const closed = () => { if (record.closedAt === null) record.closedAt = Date.now() }
    request.socket.on('close', closed)
    response.on('close', closed)
    request.socket.on('end', closed)
    request.on('error', () => {})
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      record.body = raw ? JSON.parse(raw) : {}
      Promise.resolve(PLANS[plan](request, response, record)).catch(() => { response.destroy() })
    })
  })
  return {
    calls,
    set plan(name) { plan = name },
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
}

let upstream
const realCliOrigin = config.qwenCliProxyUrl

test.before(async () => {
  await accountManager._initPromise
  upstream = cliUpstream()
  // The only CLI origin the application is given.
  config.qwenCliProxyUrl = await upstream.listen()
})
test.beforeEach(() => {
  upstream.plan = 'short'
  upstream.calls.length = 0
  ACCOUNT.cli_info.request_number = 0
})
test.after(async () => {
  config.qwenCliProxyUrl = realCliOrigin
  await upstream.close()
  accountManager.destroy()
})

/** The call the application made, once it made one. */
const callMade = async (what = 'the call to the CLI upstream') => {
  await until(() => upstream.calls.length === 1, what)
  return upstream.calls[0]
}
/**
 * The upstream hung up on: its side of the connection is told of the application's
 * a few milliseconds after — in a test, as on the wire.
 */
const hungUpSoon = async (call, what) => {
  for (let waited = 0; call.closedAt === null && waited < 2000; waited += 5) await delay(5)
  assert.notEqual(call.closedAt, null, `${what}: the upstream was not hung up on`)
}
/** A client that left: the upstream hung up on, and no more generated than a few frames. */
const hungUpOn = async (call, what) => {
  await hungUpSoon(call, what)
  assert.equal(call.endedAt, null, `${what}: the answer ran to its end — nobody closed it`)
  assert.ok(call.sent < 20, `${what}: ${call.sent} frames were generated for nobody`)
}

describe('the CLI path: a stream', () => {
  it('the client leaving mid-answer closes the upstream; no error frame, no error line, nothing charged', HELD, async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    const errors = recorded(context, accountManager, 'recordAccountError')
    const stats = recorded(context, accountManager, 'accumulateStats')
    upstream.plan = 'long'
    const req = liveRequest({ account: ACCOUNT, body: streamed() })
    const res = bunResponse()

    const handling = handleCliChatCompletion(req, res)
    await until(() => res.output.includes('word'), 'the first frame of the answer')
    req.leave()
    await handling

    await hungUpOn(upstream.calls[0], 'stream, as Bun reports it')
    assert.doesNotMatch(res.output, /"error"/, 'no error frame is written for a client that is gone')
    assert.doesNotMatch(res.output, /\[DONE\]/, 'nothing is finished for a client that is gone')
    assert.deepEqual(logs, [])
    assert.deepEqual(failures, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(stats, [])
  })

  it('the same by the socket\'s close, as Node reports it', HELD, async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    upstream.plan = 'long'
    const req = liveRequest({ account: ACCOUNT, body: streamed() })
    const res = bunResponse()

    const handling = handleCliChatCompletion(req, res)
    await until(() => res.output.includes('word'), 'the first frame of the answer')
    req.leave('events')
    await handling

    await hungUpOn(upstream.calls[0], 'stream, as Node reports it')
    assert.doesNotMatch(res.output, /"error"/)
    assert.deepEqual(logs, [])
    assert.deepEqual(failures, [])
  })

  it('the client leaving while the upstream has not answered yet cancels the call', SOON, async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    upstream.plan = 'silent'
    const req = liveRequest({ account: ACCOUNT, body: streamed() })
    const res = bunResponse()

    const handling = handleCliChatCompletion(req, res)
    await callMade()
    req.leave()
    await handling

    await hungUpSoon(upstream.calls[0], 'stream, the upstream silent')
    assert.equal(upstream.calls[0].endedAt, null)
    assert.equal(res.output, '', 'nothing is written for a client that is gone')
    assert.deepEqual(logs, [])
    assert.deepEqual(failures, [])
  })

  it('the client staying: the answer and its [DONE], the usage charged — as before', async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    const stats = recorded(context, accountManager, 'accumulateStats')
    const req = liveRequest({ account: ACCOUNT, body: streamed() })
    const res = bunResponse()

    await handleCliChatCompletion(req, res)

    assert.match(res.output, /word/)
    assert.match(res.output, /\[DONE\]/)
    assert.equal(upstream.calls[0].endedAt !== null, true, 'the answer ran to its end')
    assert.deepEqual(failures, [])
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [[EMAIL, 'cli', { calls: 1, input: 0, output: 0 }]])
  })

  it('a road that breaks under a client that stayed is still the failure it is', async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    upstream.plan = 'broken'
    const req = liveRequest({ account: ACCOUNT, body: streamed() })
    const res = bunResponse()

    await handleCliChatCompletion(req, res)

    assert.equal(res.statusCode, 503, 'the failure is the client\'s')
    assert.equal(failures.length, 1, 'and it is the account\'s failure, as before')
    assert.equal(logs.length, 1)
  })
})

describe('the CLI path: a whole JSON answer', () => {
  it('the client leaving while the upstream has not answered yet cancels the call; no JSON, nothing charged', SOON, async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    const errors = recorded(context, accountManager, 'recordAccountError')
    const stats = recorded(context, accountManager, 'accumulateStats')
    upstream.plan = 'silent'
    const req = liveRequest({ account: ACCOUNT, body: whole() })
    const res = bunResponse()

    const handling = handleCliChatCompletion(req, res)
    await callMade()
    req.leave()
    await handling

    await hungUpSoon(upstream.calls[0], 'JSON, the upstream silent')
    assert.equal(upstream.calls[0].endedAt, null)
    assert.equal(res.body, null, 'no JSON is built for a client that is gone')
    assert.equal(res.writableEnded, false)
    assert.deepEqual(logs, [])
    assert.deepEqual(failures, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(stats, [])
  })

  it('the client staying: the answer and the usage charged — as before', async context => {
    const logs = recorded(context, logger, 'error')
    const failures = recorded(context, accountManager, 'recordAccountFailure')
    const stats = recorded(context, accountManager, 'accumulateStats')
    upstream.plan = 'whole'
    const req = liveRequest({ account: ACCOUNT, body: whole() })
    const res = bunResponse()

    await handleCliChatCompletion(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, 'pong')
    assert.deepEqual(failures, [])
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [[EMAIL, 'cli', { calls: 1, input: 4, output: 1 }]])
  })
})
