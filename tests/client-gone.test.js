// A client that goes away takes its upstream with it (Qwen2API-mxs).
//
// The signal is the request's — `req` and its socket — never the response's: under Bun,
// the runtime on prod, `res` says nothing when the client leaves (no 'close', `destroyed`
// undefined, `write` returning true). Every path used to watch `res`, so the gate (Node,
// where `res` does speak) was green while on prod the generation went on to its end after
// each client timeout, on the account's quota.
//
// And under Bun the request says nothing either, once express.json has read its body —
// which is every request of the application. Measured on 1.3.14: no event, no flag; the
// socket only loses its address. So the handlers are driven here the way Bun behaves
// (liveRequest#leave), with a response that reports only what Bun reports. Node's own
// signals are covered too: every runtime that reports them is listened to.
//
// The runtime itself is exercised by tools/client-gone-smoke.js: the application on Bun,
// a stand-in for the worker on Node, a client on a real socket.
//
// Same header as tests/agent-account-failover.test.js: without API_KEY the startup cuts the
// process before the runner reports, and without DATA_SAVE_MODE=none account.js would try a
// real login on import.
process.env.API_KEY = 'client-gone-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const { test, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')

const accountManager = require('../src/utils/account')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const { logger } = require('../src/utils/logger')
const { resetChatChallengeBreaker, isRateLimitError, isTransportInterruption } = require('../src/utils/upstream-error')
const AccountRotator = require('../src/utils/account-rotator')
const {
  ClientGoneError, isClientGone, watchClient, consumeWhileClientStays
} = require('../src/utils/client-gone')
const { runOpenAIAgentTurn, collectOpenAIAgentAttempt } = require('../src/utils/openai-agent-runtime')

// The controllers capture sendChatRequest when they are first required: the stub goes in
// before, and each test says what it answers.
const requestModule = require('../src/utils/request.js')
let sendChatRequest = async () => ({ status: false, response: null })
requestModule.sendChatRequest = (...args) => sendChatRequest(...args)
const {
  handleAnthropicMessages, handleAnthropicStream, handleAnthropicNonStream, consumeUpstream
} = require('../src/controllers/anthropic.js')
const { handleChatCompletion, handleStreamResponse, handleNonStreamResponse } = require('../src/controllers/chat.js')

const ACCOUNT = { email: 'client-gone@example.invalid', token: 'client-gone-test-token' }
const requestBody = { model: 'qwen-test', stream: true, messages: [{ role: 'user', content: 'Say pong' }] }
const TOOL_OPTIONS = { has_tools: true, allowed_tool_names: ['get_time'], tool_choice: 'auto' }
// Long enough for a loaded CI runner, short enough that a read that was never closed fails
// the test instead of hanging it: every held stream below never ends by itself.
const HELD = { timeout: 10000 }
// How often the handlers' watches ask the socket here. The application asks every
// quarter of a second; a test should not take that long to learn the same.
const ASKING = { pollMs: 5 }
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const DONE = 'data: [DONE]\n\n'
const answerPayload = content =>
  JSON.stringify({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })
const answer = content => frame({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })
const think = content => frame({ choices: [{ delta: { phase: 'think', content }, finish_reason: null }] })
const finished = () => [
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
  DONE
]
const FINAL = '<agent_final>OK</agent_final>'
// A tool call of the text channel, as the agent prompts ask for it, for a declared tool.
const CALL = '[TOOL CALL]{"name":"get_time","arguments":{}}[END TOOL CALL]'
const fullAnswer = (content = 'pong') => Readable.from([answer(content), ...finished()])
const fullAgentTurn = (content = FINAL) => Readable.from([answer(content), ...finished()])
// The quota packet as Qwen sends it in a frame of the answer (tests/upstream-quota-429.test.js).
const QUOTA = frame({
  success: false,
  data: { code: 'RateLimited', details: "You've reached the upper limit for today's usage." }
})

test.before(async () => { await accountManager._initPromise })
test.beforeEach(() => {
  accountManager.accountTokens = [ACCOUNT]
  accountManager.isInitialized = true
  sendChatRequest = async () => ({ status: false, response: null })
  resetChatChallengeBreaker()
})
test.after(() => { accountManager.destroy() })

/**
 * A request as the handlers get it from Express, and the ways its client can go —
 * each what a runtime was measured doing with a body express.json read:
 *
 *   leave()            — Bun 1.3.14, every request of the application: no event, no
 *                        flag; the socket loses its address, and that is all.
 *   leave('events')    — Node: 'end' and 'close' on the socket, `socket.destroyed`
 *                        true; `address()` keeps answering, with nothing in it.
 *   leave('emptied')   — a socket that only answers `address()` with nothing in it,
 *                        the way Node's does once it closed: not by a flag, not by
 *                        an event.
 */
const liveRequest = (extra = {}) => {
  let address = { address: '127.0.0.1', family: 'IPv4', port: 42424 }
  const socket = Object.assign(new EventEmitter(), { destroyed: false, address: () => address })
  const req = Object.assign(new EventEmitter(), { socket, aborted: false }, extra)
  req.leave = (how = 'address') => {
    address = null
    if (how === 'emptied') address = { address: undefined, family: undefined, port: undefined }
    if (how !== 'events') return
    address = { address: undefined, family: undefined, port: undefined }
    socket.destroyed = true
    socket.emit('end')
    socket.emit('close')
  }
  return req
}

/**
 * A response that says only what Bun says (measured as above): `destroyed` never turns
 * true, and `write` keeps returning true after the client left. No `flushHeaders` or
 * `flush` on purpose: neither exists under Bun.
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

/** What a gone client must not cost: an error line. */
const recordedErrors = context => {
  const calls = []
  context.mock.method(logger, 'error', (...args) => calls.push(args))
  return calls
}
/** ...nor usage on the account. */
const recordedStats = context => {
  const calls = []
  context.mock.method(accountManager, 'accumulateStats', (...args) => calls.push(args))
  return calls
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const until = async (condition, what) => {
  for (let waited = 0; !condition() && waited < 2000; waited += 5) await pause(5)
  assert.ok(condition(), `not within 2 s: ${what}`)
}

/**
 * An upstream with `head` in it that then stands still until `release()` — the way the
 * egress and the impersonating transport hand an answer over: a Readable pushed from aside
 * (browser-egress.js#handOff), which closes the moment it is destroyed. `ready` resolves
 * once the consumer took all of `head` and had a turn to finish with it. The only ways for
 * a consumer to finish are the release or the stream being closed.
 */
const held = (head) => {
  const stream = new Readable({ read() {} })
  for (const chunk of head) stream.push(chunk)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const ready = (async () => {
    while (stream.readableLength > 0 && !stream.destroyed) {
      await new Promise(resolve => setImmediate(resolve))
    }
    await new Promise(resolve => setImmediate(resolve))
  })()
  gate.then(() => { if (!stream.destroyed) stream.push(answer('too late')) })
  return { stream, ready, release }
}

/**
 * Waits for `handling` (a promise that never rejects) to have read the head of `upstream`.
 * A handling that ended before it got there says so here, instead of leaving a timeout to
 * be guessed at.
 */
const afterHead = async (upstream, handling) => {
  await Promise.race([
    upstream.ready,
    handling.then(outcome => {
      throw new Error(`the handling ended before it read the answer: ${outcome?.stack || outcome}`)
    })
  ])
}
/** Lets nothing of a test outlive it: the gate opened, the handling awaited to its end. */
const endHeld = async (upstream, handling) => {
  upstream.release()
  await handling
}

/** An upstream that answers `chunks`, and whose client leaves as the last one is read. */
const leavingWith = (req, chunks, how = 'address') => Readable.from((async function* () {
  for (const chunk of chunks) yield chunk
  req.leave(how)
})())

/**
 * A frame the handler already had in hand when the client left: it is answered after
 * `leave()`, whatever was done to close the stream.
 */
const frameInHand = (req, chunk) => ({
  destroyed: false,
  destroy() { this.destroyed = true },
  async *[Symbol.asyncIterator]() {
    req.leave()
    yield chunk
  }
})

/**
 * An upstream whose transport breaks as the consumer asks for its first chunk —
 * after `before()` ran, which is when the client is to leave.
 */
const breakingWith = (error, before = () => {}) => new Readable({
  read() {
    before()
    this.destroy(error)
  }
})
const socketClose = () => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })

const anthropicCtx = (req, overrides = {}) => ({
  message_id: 'msg_client_gone',
  model: 'qwen3-max',
  hasTools: false,
  toolChoice: 'auto',
  requestBody: { model: 'qwen3-max', messages: [{ role: 'user', content: 'hola' }] },
  currentAccount: { ...ACCOUNT },
  upstreamOptions: { allowContextCompaction: true, contextPrefixKey: 'client-gone-k1' },
  client: watchClient(req, ASKING),
  ...overrides
})

describe('watchClient: the signal is the socket\'s — its close, and its address', () => {
  it('a live client is not gone; once it left, every check says so for good — on Bun as on Node', () => {
    for (const how of ['events', 'address', 'emptied']) {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const told = []
      client.onGone(() => told.push('gone'))

      assert.equal(client.gone(), false, how)
      assert.deepEqual(told, [])

      req.leave(how)

      assert.equal(client.gone(), true, how)
      assert.equal(client.gone(), true, `${how}: stays seen`)
      assert.deepEqual(told, ['gone'], `${how}: each handler is told once`)
    }
  })

  it('on Bun nothing reports a client that leaves: the asking alone finds it, and tells the handlers', async () => {
    for (const how of ['address', 'emptied']) {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const told = []
      client.onGone(() => told.push('gone'))

      req.leave(how)

      assert.equal(req.aborted, false, `${how}: no flag`)
      assert.equal(req.socket.destroyed, false, `${how}: no flag here either`)
      assert.deepEqual(told, [], `${how}: and no event told anything yet`)
      await until(() => told.length === 1, `${how}: the socket asked whether it still has its address`)
    }
  })

  it('on Node the socket\'s close tells the handlers at once, before any asking', () => {
    const req = liveRequest()
    const client = watchClient(req, { pollMs: 60000 })
    const told = []
    client.onGone(() => told.push('gone'))

    req.leave('events')

    assert.deepEqual(told, ['gone'], 'told by the event, not by the asking')
  })

  it('a request already abandoned when watched is gone from the start, and handlers told at once', () => {
    for (const shape of ['aborted', 'socketDestroyed', 'addressLost', 'emptied', 'events']) {
      const req = liveRequest()
      if (shape === 'aborted') req.aborted = true
      if (shape === 'socketDestroyed') req.socket.destroyed = true
      if (shape === 'addressLost') req.leave()
      if (shape === 'emptied') req.leave('emptied')
      if (shape === 'events') req.leave('events')
      const client = watchClient(req, ASKING)
      const told = []
      client.onGone(() => told.push('gone'))

      assert.equal(client.gone(), true, shape)
      assert.deepEqual(told, ['gone'], shape)
    }
  })

  it("the request's own close is not the client leaving: a body read to its end closes out the same way", () => {
    // Measured on Bun and on Node: once the body was read, `req` has emitted 'close'
    // already — before any handler runs — with the request not aborted and its socket
    // alive. It is not listened to.
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    let told = 0
    client.onGone(() => { told += 1 })

    req.emit('close')

    assert.equal(client.gone(), false)
    assert.equal(told, 0)
  })

  it('the socket closing under the request is the client leaving, aborted or not', () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    client.onGone(() => {})

    req.socket.destroyed = true
    req.socket.emit('close')

    assert.equal(client.gone(), true)
  })

  it('a socket that never had an address cannot lose it', () => {
    const socket = new EventEmitter()
    const req = Object.assign(new EventEmitter(), { socket, aborted: false })
    const client = watchClient(req, ASKING)

    socket.address = () => null
    req.emit('close')

    assert.equal(client.gone(), false, 'nothing to go by: not a client that left')
  })

  it('dispose ends the watch: no listener is left, and nothing of the request is heeded any more', () => {
    for (const how of ['events', 'address']) {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      let told = 0
      client.onGone(() => { told += 1 })

      client.dispose()
      client.dispose()
      // The socket outlives the request on keep-alive: its closing later is not this client.
      req.leave(how)

      assert.equal(told, 0, how)
      assert.equal(client.gone(), false, how)
      assert.equal(req.socket.listenerCount('close'), 0, `${how}: nothing of the watch is left on the socket`)
    }
  })

  it('dispose stops the asking: no timer of the watch outlives the request', context => {
    // The timers are unref'd, so they keep nothing alive and show in no count of
    // resources: they are counted where they are made.
    const timers = new Set()
    context.mock.method(globalThis, 'setInterval', (...args) => {
      const timer = originalSetInterval(...args)
      timers.add(timer)
      return timer
    })
    context.mock.method(globalThis, 'clearInterval', (timer) => {
      timers.delete(timer)
      originalClearInterval(timer)
    })

    const watches = Array.from({ length: 20 }, () => watchClient(liveRequest(), ASKING))
    assert.equal(timers.size, 20, 'each watch asks on a timer of its own')

    for (const watch of watches) watch.dispose()

    assert.equal(timers.size, 0, 'and every timer of them is gone with its request')
  })

  it('a handler can be taken back before the client leaves', () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    let told = 0
    const forget = client.onGone(() => { told += 1 })

    forget()
    req.leave('events')

    assert.equal(told, 0)
  })

  it('a handler that throws does not keep the next one from being told', () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    const order = []
    client.onGone(() => { order.push('first'); throw new Error('a handler of its own') })
    client.onGone(() => order.push('second'))

    assert.doesNotThrow(() => req.leave('events'))
    assert.deepEqual(order, ['first', 'second'])
  })

  it('nothing to watch — a bare request object, as the tests drive the handlers — is a client that stays', () => {
    for (const bare of [{}, null, undefined]) {
      const client = watchClient(bare)
      assert.equal(client.gone(), false)
      assert.doesNotThrow(() => {
        client.onGone(null)
        client.onGone(() => assert.fail('never called'))
        client.dispose()
        client.dispose()
      })
    }
  })
})

describe('consumeWhileClientStays', () => {
  it('without a client it is consumeSSEStream, stop predicate included', async () => {
    const seen = []
    const plain = await consumeWhileClientStays(Readable.from([answer('a'), answer('b'), DONE]), f => seen.push(f.data))

    assert.deepEqual(seen, [answerPayload('a'), answerPayload('b'), '[DONE]'])
    assert.deepEqual(
      Object.keys(plain).sort(), ['bytesRead', 'completed', 'eventCount', 'sawDone', 'stopped'])

    const stopped = await consumeWhileClientStays(Readable.from([answer('a'), answer('b')]), () => {}, {
      shouldStop: () => true
    })
    assert.deepEqual(stopped, {
      sawDone: false, eventCount: 1, bytesRead: answer('a').length, completed: true, stopped: true
    })
  })

  it('the client leaving closes an idle upstream, and the read ends as ClientGoneError — on Bun, with nothing but the address going',
    HELD, async () => {
      // The egress hands an answer over as a Readable pushed from aside (browser-egress.js#handOff).
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const upstream = new Readable({ read() {} })
      upstream.push(answer('Hel'))
      const reading = consumeWhileClientStays(upstream, () => {}, { client }).catch(error => error)

      await new Promise(resolve => setImmediate(resolve))
      assert.equal(upstream.destroyed, false, 'open while the client is there')

      req.leave()

      const error = await reading
      assert.ok(isClientGone(error), `ClientGoneError, got ${error && error.code}`)
      assert.equal(error.code, 'client_gone')
      assert.equal(error instanceof ClientGoneError, true)
      assert.equal(isTransportInterruption(error), false, 'a closing is not an interruption of the transport')
      assert.equal(upstream.destroyed, true, 'closed by the reading')
    })

  it('the client leaving while a frame is still being handled ends the read there: no later frame is delivered',
    async () => {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const upstream = Readable.from([answer('one'), answer('two'), answer('three')])
      const seen = []
      const reading = consumeWhileClientStays(upstream, async f => {
        seen.push(f.data)
        await new Promise(resolve => setImmediate(resolve))
        // The client goes while this frame is still being handled, and says so at once.
        req.leave('events')
        await new Promise(resolve => setImmediate(resolve))
      }, { client }).catch(error => error)

      assert.ok(isClientGone(await reading))
      assert.deepEqual(seen, [answerPayload('one')])
      assert.equal(upstream.destroyed, true)
    })

  it('a client already gone when the read starts: the upstream is closed before a frame is read', async () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    req.leave()
    const upstream = fullAnswer()
    let seen = 0

    await assert.rejects(consumeWhileClientStays(upstream, () => { seen += 1 }, { client }), isClientGone)
    assert.equal(seen, 0)
    assert.equal(upstream.destroyed, true)
  })

  it('a transport that breaks under a client already gone is the client leaving, not an interruption', async () => {
    for (const how of ['events', 'address']) {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const broken = breakingWith(socketClose(), () => req.leave(how))

      await assert.rejects(consumeWhileClientStays(broken, () => {}, { client }), isClientGone)
    }
  })

  it('a fault of the transport that is not a cut is not hidden under the leaving', async () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    const malformed = Object.assign(new Error('Signin worker returned a malformed egress stream (not an event).'),
      { code: 'EGRESS_RELAY_MALFORMED' })
    const failing = breakingWith(malformed, () => req.leave())

    await assert.rejects(consumeWhileClientStays(failing, () => {}, { client }), error => error === malformed)
  })

  it('what a frame says the upstream decided stays what it was, under a client that is gone', async () => {
    // A quota frame is thrown by the handler of the frame, and carries the account's
    // bookkeeping: whoever is left to read it, it is not the client's leaving.
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    const quota = Object.assign(new Error("You've reached the upper limit for today's usage."), {
      name: 'UpstreamResponseError', code: 'RateLimited'
    })

    await assert.rejects(consumeWhileClientStays(Readable.from([QUOTA]), async () => {
      req.leave('events')
      throw quota
    }, { client }), error => error === quota)
  })

  it('a fault of the handler that is not the closing is not hidden under the leaving', async () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    const bug = new TypeError('a bug of the handler')

    await assert.rejects(consumeWhileClientStays(Readable.from([answer('x')]), async () => {
      req.leave('events')
      throw bug
    }, { client }), error => error === bug)
  })

  it('the same transport code with the client still there is the interruption it always was', async () => {
    const client = watchClient(liveRequest(), ASKING)
    const closing = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    const broken = breakingWith(closing)

    await assert.rejects(consumeWhileClientStays(broken, () => {}, { client }), error => error === closing)
  })

  it('an answer read to its end as the client leaves is the client leaving too, not a round for a gate', async () => {
    const req = liveRequest()
    const client = watchClient(req, ASKING)

    await assert.rejects(
      consumeWhileClientStays(leavingWith(req, [answer('done'), ...finished()]), () => {}, { client }), isClientGone)
  })

  it('with the client there to the end the read is consumeSSEStream, and nothing is closed by the reading', async () => {
    const client = watchClient(liveRequest(), ASKING)
    const upstream = fullAnswer()
    const seen = []

    const result = await consumeWhileClientStays(upstream, f => seen.push(f.data), { client })

    assert.equal(result.completed, true)
    assert.equal(result.stopped, false)
    assert.equal(result.sawDone, true)
    assert.deepEqual(seen, [answerPayload('pong'), finished()[0].slice(6, -2), '[DONE]'])
    assert.equal(upstream.readableEnded, true, 'read to its end: nothing was closed before it')
  })

  it('a stop of the handler\'s own with the client there returns like consumeSSEStream does', async () => {
    const client = watchClient(liveRequest(), ASKING)
    const upstream = fullAnswer()

    const result = await consumeWhileClientStays(upstream, () => {}, { client, shouldStop: () => true })

    assert.equal(result.stopped, true)
    assert.equal(result.eventCount, 1)
    assert.equal(upstream.destroyed, true, 'the break of sse.js closes the source, as always')
  })
})

describe('consumeUpstream (anthropic.js) reads by the same rule', () => {
  it('closes the upstream and lets ClientGoneError out when the client leaves', HELD, async () => {
    const req = liveRequest()
    const upstream = held([answer('Half an ans')])
    const reading = consumeUpstream(upstream.stream, () => {}, { client: watchClient(req, ASKING) }).catch(error => error)
    try {
      await afterHead(upstream, reading)
      req.leave()
      assert.ok(isClientGone(await reading))
      assert.equal(upstream.stream.destroyed, true)
    } finally {
      await endHeld(upstream, reading)
    }
  })

  it('with a client that stays it reads to the end', async () => {
    const client = watchClient(liveRequest(), ASKING)
    const seen = []
    const result = await consumeUpstream(fullAnswer(), json => seen.push(json), { client })

    assert.equal(result.completed, true)
    assert.equal(seen.length, 2, 'the answer and the final frame; [DONE] is not JSON')
  })
})

describe('OpenAI /v1/chat/completions, plain answer', () => {
  const plain = (req, extra = {}) => ({ currentAccount: ACCOUNT, client: watchClient(req, ASKING), ...extra })

  it('stream: the client leaving mid-answer closes the upstream; no error frame, no error line, no usage',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('Hel')])
      const handling = handleStreamResponse(res, upstream.stream, false, false, requestBody, plain(req))
      try {
        await afterHead(upstream, handling)
        assert.match(res.output, /Hel/, 'the first frame went out while the client was there')
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true, 'the upstream was closed')
      assert.doesNotMatch(res.output, /too late/)
      assert.doesNotMatch(res.output, /"error"/)
      assert.doesNotMatch(res.output, /\[DONE\]/, 'nothing is finished for a client that is gone')
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    })

  it('stream: the empty-answer retry is not sent for a client that left as the answer ended', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    // Reasoning and nothing else: an answer the handler retries for a client that stayed.
    let sent = 0
    sendChatRequest = async () => { sent += 1; return { status: true, response: fullAnswer() } }

    await handleStreamResponse(res, leavingWith(req, [think('hm'), ...finished()]), false, false, requestBody,
      plain(req, { sendChatRequest }))

    assert.equal(sent, 0, 'no second request upstream')
    assert.doesNotMatch(res.output, /"error"/)
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [])
  })

  it('stream: the client leaving while the retry is being made closes that answer as soon as it arrives',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const retry = held([answer('never read')])
      sendChatRequest = async () => {
        req.leave()
        return { status: true, response: retry.stream }
      }

      const handling = handleStreamResponse(res, Readable.from([think('hm'), ...finished()]), false, false, requestBody,
        plain(req, { sendChatRequest }))
      try {
        await handling
        assert.equal(retry.stream.destroyed, true, 'closed before a frame of it was read')
        assert.doesNotMatch(res.output, /never read/)
        assert.doesNotMatch(res.output, /"error"/)
        assert.deepEqual(logs, [])
        assert.deepEqual(stats, [])
      } finally {
        await endHeld(retry, handling)
      }
    })

  it('stream: a client already gone when the answer arrives gets nothing read on its behalf', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest()
    const client = watchClient(req, ASKING)
    req.leave()
    const res = bunResponse()
    const upstream = fullAnswer('never read')

    await handleStreamResponse(res, upstream, false, false, requestBody, plain(req, { client }))

    assert.equal(upstream.destroyed, true)
    assert.equal(res.output, '')
    assert.deepEqual(logs, [])
  })

  it('stream: a quota frame read as the client leaves still marks the account', async context => {
    const logs = recordedErrors(context)
    const marked = []
    context.mock.method(accountManager, 'recordAccountQuotaExhausted', (...args) => marked.push(args))
    const req = liveRequest()
    const res = bunResponse()
    const answering = leavingWith(req, [QUOTA])

    await handleStreamResponse(res, answering, false, false, requestBody, plain(req))

    assert.deepEqual(marked.map(call => call[0]), [ACCOUNT.email], 'the account is put on its cooldown')
    assert.equal(logs.filter(call => call[0] === '聊天处理错误').length, 1, 'and the failure is still logged as one')
  })

  it('no stream: the client leaving mid-answer closes the upstream; nothing is answered, nothing is charged',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('Hel')])
      const handling = handleNonStreamResponse(res, upstream.stream, false, false, 'qwen-test', requestBody, plain(req))
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.equal(res.body, null, 'no JSON is built for a client that is gone')
      assert.equal(res.output, '')
      assert.equal(res.writableEnded, false)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    })

  it('no stream: the client leaving while the retry is being made closes that answer as soon as it arrives',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const retry = held([answer('never read')])
      sendChatRequest = async () => {
        req.leave()
        return { status: true, response: retry.stream }
      }

      const handling = handleNonStreamResponse(res, Readable.from([think('hm'), ...finished()]), false, false,
        'qwen-test', requestBody, plain(req, { sendChatRequest }))
      try {
        await handling
        assert.equal(retry.stream.destroyed, true, 'closed before a frame of it was read')
        assert.equal(res.body, null, 'and no error is answered for it')
        assert.equal(res.output, '')
        assert.deepEqual(logs, [])
        assert.deepEqual(stats, [])
      } finally {
        await endHeld(retry, handling)
      }
    })

  it('no stream: the empty-answer retry is not sent for a client that left', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    sendChatRequest = async () => { sent += 1; return { status: true, response: fullAnswer() } }

    await handleNonStreamResponse(res, leavingWith(req, [think('hm'), ...finished()]), false, false, 'qwen-test',
      requestBody, plain(req, { sendChatRequest }))

    assert.equal(sent, 0)
    assert.equal(res.body, null)
    assert.deepEqual(logs, [])
  })

  it('the request itself, stream: through handleChatCompletion the read ends quietly and the watch is dropped',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest({ body: requestBody, enable_thinking: false, enable_web_search: false, has_tools: false })
      const res = bunResponse()
      const upstream = held([answer('Hel')])
      sendChatRequest = async () => ({ status: true, response: upstream.stream, currentAccount: { ...ACCOUNT } })

      const handling = handleChatCompletion(req, res)
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.doesNotMatch(res.output, /"error"/)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
      assert.equal(req.listenerCount('aborted') + req.listenerCount('close') + req.socket.listenerCount('close'), 0)
    })

  it('the request itself, no stream: through handleChatCompletion the read ends quietly and the watch is dropped',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest({
        body: { ...requestBody, stream: false }, enable_thinking: false, enable_web_search: false, has_tools: false
      })
      const res = bunResponse()
      const upstream = held([answer('Hel')])
      sendChatRequest = async () => ({ status: true, response: upstream.stream, currentAccount: { ...ACCOUNT } })

      const handling = handleChatCompletion(req, res)
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.equal(res.body, null)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
      assert.equal(req.listenerCount('aborted') + req.listenerCount('close') + req.socket.listenerCount('close'), 0)
    })

  it('a client that stays gets its answer, as before, and the watch is dropped the same', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    for (const stream of [true, false]) {
      const req = liveRequest({
        body: { ...requestBody, stream }, enable_thinking: false, enable_web_search: false, has_tools: false
      })
      const res = bunResponse()
      sendChatRequest = async () => ({ status: true, response: fullAnswer(), currentAccount: { ...ACCOUNT } })

      await handleChatCompletion(req, res)

      if (stream) {
        assert.match(res.output, /pong/)
        assert.match(res.output, /\[DONE\]/)
      } else {
        assert.equal(res.body.choices[0].message.content, 'pong')
      }
      assert.deepEqual(logs, [])
      assert.equal(req.listenerCount('aborted') + req.listenerCount('close') + req.socket.listenerCount('close'), 0)
    }
    assert.deepEqual(stats.map(call => call.slice(1)), [
      ['chat', { input: 4, output: 1 }], ['chat', { input: 4, output: 1 }]
    ])
  })
})

describe('OpenAI /v1/chat/completions, a turn with tools', () => {
  const turn = (req, extra = {}) => ({
    ...TOOL_OPTIONS, currentAccount: ACCOUNT, requestBody, client: watchClient(req, ASKING), ...extra
  })

  it('stream: the client leaving mid-turn ends the turn; nothing is committed after, nothing is charged',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('<agent_final>Half way')])
      const handling = handleStreamResponse(res, upstream.stream, false, false, requestBody, turn(req))
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.doesNotMatch(res.output, /"error"/)
      assert.doesNotMatch(res.output, /\[DONE\]/)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    })

  it('no stream: the client leaving mid-turn ends the turn; nothing is answered, nothing is charged',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('<agent_final>Half way')])
      const handling = handleNonStreamResponse(res, upstream.stream, false, false, 'qwen-test', requestBody, turn(req))
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.equal(res.body, null)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    })

  it('stream: a turn the gate rejects is not retried for a client that left as the turn ended', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    sendChatRequest = async () => { sent += 1; return { status: true, response: fullAgentTurn() } }

    // Bare prose, no <agent_final>: rejected, and retried for a client that stayed.
    await handleStreamResponse(res, leavingWith(req, [answer('Still working'), ...finished()]), false, false,
      requestBody, turn(req, { sendChatRequest }))

    assert.equal(sent, 0, 'no correcting request upstream')
    assert.doesNotMatch(res.output, /"error"/)
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [])
  })

  it('no stream: a turn the gate rejects is not retried for a client that left as the turn ended', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    sendChatRequest = async () => { sent += 1; return { status: true, response: fullAgentTurn() } }

    await handleNonStreamResponse(res, leavingWith(req, [answer('Still working'), ...finished()]), false, false,
      'qwen-test', requestBody, turn(req, { sendChatRequest }))

    assert.equal(sent, 0)
    assert.equal(res.body, null)
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [])
  })

  it('the client leaving while a correcting request is being made closes its answer unread', HELD, async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    const correction = held([answer('never read')])
    sendChatRequest = async () => {
      req.leave()
      return { status: true, response: correction.stream }
    }

    const handling = handleStreamResponse(res, Readable.from([answer('Still working'), ...finished()]), false, false,
      requestBody, turn(req, { sendChatRequest }))
    try {
      await handling
      assert.equal(correction.stream.destroyed, true)
      assert.doesNotMatch(res.output, /never read/)
      assert.doesNotMatch(res.output, /"error"/)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    } finally {
      await endHeld(correction, handling)
    }
  })

  it('the runtime itself: an attempt the client leaves rejects with ClientGoneError, and the turn lets it out as it is',
    HELD, async () => {
      const req = liveRequest()
      const client = watchClient(req, ASKING)
      const upstream = held([answer(FINAL)])
      const collecting = collectOpenAIAgentAttempt(upstream.stream, { ...TOOL_OPTIONS, client }).catch(error => error)
      try {
        await afterHead(upstream, collecting)
        req.leave()
        assert.ok(isClientGone(await collecting))
        assert.equal(upstream.stream.destroyed, true)
      } finally {
        await endHeld(upstream, collecting)
      }

      const outcome = await runOpenAIAgentTurn(leavingWith(req, [answer('Still working'), ...finished()]), {
        ...TOOL_OPTIONS, currentAccount: ACCOUNT, requestBody, client,
        sendChatRequest: async () => assert.fail('no correcting request for a client that left')
      }).catch(error => error)
      assert.ok(isClientGone(outcome))
    })

  it('a quota frame the turn already had in hand is not failed over to another account for a client that left', async () => {
    const second = { email: 'client-gone-2@example.invalid', token: 'client-gone-test-token-2' }
    accountManager.accountRotator = new AccountRotator()
    accountManager.accountRotator.setAccounts([ACCOUNT, second])
    const req = liveRequest()

    const outcome = await runOpenAIAgentTurn(frameInHand(req, QUOTA), {
      ...TOOL_OPTIONS, currentAccount: ACCOUNT, requestBody, client: watchClient(req, ASKING),
      sendChatRequest: async () => assert.fail('no other account is asked to serve a client that left')
    }).catch(error => error)

    assert.equal(isRateLimitError(outcome), true, 'the quota is still the quota')
    assert.ok(accountManager.accountRotator.quotaCooldownUntil.has(ACCOUNT.email),
      'and the account is still put on its cooldown')
  })

  it('a client that stays gets its turn, as before — a rejected round is corrected', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    for (const stream of [true, false]) {
      const req = liveRequest()
      const res = bunResponse()
      sendChatRequest = async () => ({ status: true, response: fullAgentTurn(), currentAccount: { ...ACCOUNT } })

      if (stream) {
        await handleStreamResponse(res, Readable.from([answer('Still working'), ...finished()]), false, false,
          requestBody, turn(req, { sendChatRequest }))
        assert.match(res.output, /OK/)
        assert.match(res.output, /\[DONE\]/)
      } else {
        await handleNonStreamResponse(res, Readable.from([answer('Still working'), ...finished()]), false, false,
          'qwen-test', requestBody, turn(req, { sendChatRequest }))
        assert.equal(res.body.choices[0].message.content, 'OK')
      }
    }
    assert.deepEqual(logs, [])
    assert.equal(stats.length, 2, 'each turn is charged to its account, once')
  })
})

describe('Anthropic /v1/messages', () => {
  const withTools = { hasTools: true, allowedToolNames: ['get_time'] }
  const required = { ...withTools, toolChoice: 'required' }
  /** What a gone client must not put in the log as a transport interruption of the egress. */
  const recordedInterruptions = context => {
    const calls = []
    context.mock.method(logger, 'warn', (...args) => calls.push(args[0]))
    return calls.filter(message => /^mid_stream_/.test(String(message)))
  }
  const messageRequest = (stream) => liveRequest({
    body: { model: 'qwen3-max', max_tokens: 64, stream, messages: [{ role: 'user', content: 'hola' }] }
  })

  it('stream: the client leaving mid-answer closes the upstream; the handler lets ClientGoneError out, nothing else happens',
    HELD, async context => {
      const logs = recordedErrors(context)
      const interruptions = recordedInterruptions(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('Half an ans')])
      let sent = 0
      const ctx = anthropicCtx(req, {
        sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
      })

      const handling = handleAnthropicStream(res, ctx, upstream.stream).catch(error => error)
      try {
        await afterHead(upstream, handling)
        assert.match(res.output, /Half an ans/)
        req.leave()
        assert.ok(isClientGone(await handling))
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.equal(sent, 0, 'no failover and no retry')
      assert.doesNotMatch(res.output, /event: error/)
      assert.doesNotMatch(res.output, /message_stop/)
      assert.deepEqual(logs, [])
      assert.deepEqual(interruptions, [])
      assert.deepEqual(stats, [])
    })

  it('stream: a socket that breaks under a client already gone is not a failover', async context => {
    for (const how of ['events', 'address']) {
      const logs = recordedErrors(context)
      const interruptions = recordedInterruptions(context)
      const req = liveRequest()
      const res = bunResponse()
      let sent = 0
      const ctx = anthropicCtx(req, {
        sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
      })
      // Nothing emitted yet: for a client that stayed this is exactly the case the failover is for.
      const breaking = breakingWith(socketClose(), () => req.leave(how))

      await assert.rejects(handleAnthropicStream(res, ctx, breaking), isClientGone)

      assert.equal(sent, 0, how)
      assert.doesNotMatch(res.output, /message_start/)
      assert.deepEqual(logs, [], how)
      assert.deepEqual(interruptions, [], how)
    }
  })

  it('stream, with tools: the client leaving mid-turn ends the turn', HELD, async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    const upstream = held([answer('Half way')])
    let sent = 0
    const ctx = anthropicCtx(req, {
      ...withTools,
      sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
    })

    const handling = handleAnthropicStream(res, ctx, upstream.stream).catch(error => error)
    try {
      await afterHead(upstream, handling)
      req.leave()
      assert.ok(isClientGone(await handling))
    } finally {
      await endHeld(upstream, handling)
    }

    assert.equal(upstream.stream.destroyed, true)
    assert.equal(sent, 0)
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [])
  })

  it('stream: a turn the gate rejects is not retried for a client that left as the turn ended', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    // tool_choice=required with no tool call: rejected, and retried for a client that stayed.
    const ctx = anthropicCtx(req, {
      ...required,
      sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
    })

    const outcome = await handleAnthropicStream(res, ctx, leavingWith(req, [answer('No tool here'), ...finished()]))
      .catch(error => error)

    assert.ok(isClientGone(outcome))
    assert.equal(sent, 0, 'no correcting request upstream')
    assert.doesNotMatch(res.output, /event: error/)
    assert.deepEqual(logs, [])
    assert.deepEqual(stats, [])
  })

  it('stream: a quota frame the handler already had in hand is not failed over for a client that left', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    const ctx = anthropicCtx(req, {
      sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
    })

    const outcome = await handleAnthropicStream(res, ctx, frameInHand(req, QUOTA)).catch(error => error)

    assert.equal(isRateLimitError(outcome), true, 'the quota is still the quota')
    assert.equal(sent, 0, 'no other account is asked to serve a client that left')
    assert.equal(logs.filter(call => call[0] === 'Anthropic 流式心跳包装失败').length, 1,
      'and it is logged as the failure of the upstream it is')
  })

  it('no stream: the client leaving mid-answer closes the upstream; the handler lets ClientGoneError out, nothing else happens',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const upstream = held([answer('Half an ans')])
      let sent = 0
      const ctx = anthropicCtx(req, {
        sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
      })

      const handling = handleAnthropicNonStream(res, ctx, upstream.stream).catch(error => error)
      try {
        await afterHead(upstream, handling)
        req.leave()
        assert.ok(isClientGone(await handling))
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true)
      assert.equal(sent, 0)
      assert.equal(res.body, null)
      assert.deepEqual(logs, [])
      assert.deepEqual(stats, [])
    })

  it('no stream: the client leaving while a correcting request is being made closes its answer unread',
    HELD, async context => {
      const logs = recordedErrors(context)
      const stats = recordedStats(context)
      const req = liveRequest()
      const res = bunResponse()
      const correction = held([answer('never read')])
      const ctx = anthropicCtx(req, {
        ...required,
        sendRequest: async () => {
          req.leave()
          return { status: true, response: correction.stream }
        }
      })

      const handling = handleAnthropicNonStream(res, ctx, Readable.from([answer('No tool here'), ...finished()]))
        .catch(error => error)
      try {
        assert.ok(isClientGone(await handling))
        assert.equal(correction.stream.destroyed, true, 'closed before a frame of it was read')
        assert.equal(res.body, null)
        assert.deepEqual(logs, [])
        assert.deepEqual(stats, [])
      } finally {
        await endHeld(correction, handling)
      }
    })

  it('no stream: a turn the gate rejects is not retried for a client that left as the turn ended', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest()
    const res = bunResponse()
    let sent = 0
    const ctx = anthropicCtx(req, {
      ...required,
      sendRequest: async () => { sent += 1; return { status: true, response: fullAnswer() } }
    })

    const outcome = await handleAnthropicNonStream(res, ctx, leavingWith(req, [answer('No tool here'), ...finished()]))
      .catch(error => error)

    assert.ok(isClientGone(outcome))
    assert.equal(sent, 0)
    assert.equal(res.body, null)
    assert.deepEqual(logs, [])
  })

  it('a client that stays gets a rejected turn corrected, as before', async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    for (const stream of [true, false]) {
      const req = liveRequest()
      const res = bunResponse()
      let sent = 0
      // tool_choice=required and a round without a tool call: rejected. The correcting
      // request brings the call, and it is made for a client that is there.
      const ctx = anthropicCtx(req, {
        ...required,
        sendRequest: async () => {
          sent += 1
          return { status: true, response: Readable.from([answer(CALL), ...finished()]) }
        }
      })
      const rejecting = Readable.from([answer('No tool here'), ...finished()])

      if (stream) await handleAnthropicStream(res, ctx, rejecting)
      else await handleAnthropicNonStream(res, ctx, rejecting)

      assert.equal(sent, 1, `stream=${stream}: one correcting request`)
      assert.match(res.output, /get_time/, `stream=${stream}: the call is delivered`)
      assert.deepEqual(logs, [])
    }
    assert.equal(stats.length, 2, 'each turn is charged to its account, once')
  })

  for (const stream of [true, false]) {
    const way = stream ? 'stream' : 'no stream'

    it(`${way}, through handleAnthropicMessages: the request ends quietly and the watch is dropped`,
      HELD, async context => {
        const logs = recordedErrors(context)
        const stats = recordedStats(context)
        const req = messageRequest(stream)
        const res = bunResponse()
        const upstream = held([answer('Half an ans')])
        sendChatRequest = async () => ({ status: true, response: upstream.stream, currentAccount: { ...ACCOUNT } })

        const handling = handleAnthropicMessages(req, res)
        try {
          await afterHead(upstream, handling)
          req.leave()
          await handling
        } finally {
          await endHeld(upstream, handling)
        }

        assert.equal(upstream.stream.destroyed, true)
        assert.doesNotMatch(res.output, /event: error/)
        assert.equal(res.body, null)
        assert.deepEqual(logs, [])
        assert.deepEqual(stats, [])
        assert.equal(req.listenerCount('aborted') + req.listenerCount('close') + req.socket.listenerCount('close'), 0)
      })

    it(`${way}: a client that stays gets its message, as before, and the watch is dropped the same`,
      async context => {
        const logs = recordedErrors(context)
        const stats = recordedStats(context)
        const req = messageRequest(stream)
        const res = bunResponse()
        sendChatRequest = async () => ({ status: true, response: fullAnswer(), currentAccount: { ...ACCOUNT } })

        await handleAnthropicMessages(req, res)

        assert.match(res.output, /pong/)
        assert.doesNotMatch(res.output, /event: error/)
        assert.deepEqual(logs, [])
        assert.equal(stats.length, 1)
        assert.equal(req.listenerCount('aborted') + req.listenerCount('close') + req.socket.listenerCount('close'), 0)
      })
  }
})
