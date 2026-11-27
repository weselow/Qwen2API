// A client that goes away takes its upstream with it on the paths of images and
// video (Qwen2API-3ue.10) — the same signal, and the same rule, as on the text
// paths (tests/client-gone.test.js, Qwen2API-mxs): the request and its socket,
// never the response, because under Bun — the runtime of prod — the response
// says nothing when its client leaves.
//
// An image or a video is generated for seconds to minutes, longer than any text
// answer: left alone, a generation went on to its end for nobody, on the
// account's quota, and a video task was polled for up to twenty minutes.
//
// The handlers are driven here the way Bun behaves (liveRequest#leave), with a
// response that reports only what Bun reports, and with the egress as its two
// seams — the generation through postCompletions, everything else through
// egressJson — answered by the test. The real thing, on Bun, with a stand-in
// for the worker watching the relay: tools/client-gone-smoke.js.
//
// Same header as tests/client-gone.test.js: without API_KEY the startup cuts the
// process before the runner reports, and without DATA_SAVE_MODE=none account.js
// would try a real login on import.
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
const {
  resetChatChallengeBreaker, setChatChallengeClockForTests
} = require('../src/utils/upstream-error')
const axios = require('axios')
const config = require('../src/config')

// chat.image.video.js captures generateChatID when it is first required: the
// stub goes in before, and each test says what it answers.
const requestModule = require('../src/utils/request.js')
let createChat = async () => 'chat-1'
requestModule.generateChatID = (...args) => createChat(...args)
// Since Qwen2API-jk9 (2026-11-27) the text controllers are driven here too, for the whole retry
// of an answer without a stream and the client that leaves in it: they capture sendChatRequest
// the same way, and each test says what it answers.
let sendChatRequest = async () => ({ status: false, response: null })
requestModule.sendChatRequest = (...args) => sendChatRequest(...args)
const wholeAnswerRetry = require('../src/utils/whole-answer-retry')
const browserEgress = require('../src/utils/browser-egress.js')
const { ChatCreationError, UpstreamResponseError, ContextExternalizationError } = require('../src/utils/upstream-error')
const { handleChatCompletion } = require('../src/controllers/chat.js')
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')
const {
  handleImageVideoCompletion, handleOpenAIImagesGeneration, handleOpenAIImagesEdit, handleOpenAIVideoGeneration
} = require('../src/controllers/chat.image.video.js')

const ACCOUNT = { email: 'client-gone-media@example.invalid', token: 'client-gone-media-test-token' }
const MODEL = 'qwen-media-test'
const IMAGE_URL = 'https://cdn.example.com/a.png'
const VIDEO_URL = 'https://cdn.example.com/v.mp4'
const T2I = { model: MODEL, stream: false, chat_type: 't2i', messages: [{ role: 'user', content: 'a cat' }] }
const T2V = { ...T2I, chat_type: 't2v' }
const PROMPT = { model: MODEL, prompt: 'a cat' }
// Long enough for a loaded CI runner, short enough that a read that was never
// closed fails the test instead of hanging it: every held stream below never
// ends by itself.
const HELD = { timeout: 10000 }
// What the handlers would otherwise sit out for seconds — a lookup's pause, a
// video task's twenty seconds — must end long before the pause is up.
const SOON = { timeout: 3000 }

const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const picture = (url = IMAGE_URL) => sse({ choices: [{ delta: { phase: 'image_gen', content: `![image](${url})` } }] })
// A piece of an image's answer with no picture in it yet.
const drawing = () => sse({ choices: [{ delta: { phase: 'answer', content: 'drawing' } }] })
// The chat challenge as a frame of the answer carries it (tests/chat-challenge.test.js).
const challenge = () => sse({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'] })
// A video's answer: the task to poll, as the direct path had Axios parse it.
const taskAnswer = () => JSON.stringify({ success: true, data: { task_id: 'task-1' } })

/**
 * A request as the handlers get it from Express, and the ways its client can go —
 * each what a runtime was measured doing with a body express.json read
 * (tests/client-gone.test.js):
 *
 *   leave()            — Bun 1.3.14, every request of the application: no event, no
 *                        flag; the socket loses its address, and that is all.
 *   leave('events')    — Node: 'end' and 'close' on the socket, `socket.destroyed`
 *                        true.
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
 * A response that says only what Bun says (measured as above): `destroyed` never
 * turns true, and `write` keeps returning true after the client left.
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
const until = async (condition, what) => {
  for (let waited = 0; !condition() && waited < 2000; waited += 5) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), `not within 2 s: ${what}`)
}

/**
 * An upstream with `head` in it that then stands still until `release()` — the way
 * the egress hands an answer over: a Readable pushed from aside
 * (browser-egress.js#handOff), which closes the moment it is destroyed. `ready`
 * resolves once the consumer took all of `head` and had a turn to finish with it.
 * The only ways for a consumer to finish are the release or the stream being
 * closed.
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
  // Released, the answer ends with a picture: one nobody was left to see.
  gate.then(() => { if (!stream.destroyed) stream.push(picture('https://cdn.example.com/late.png')) })
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

// What the egress answers, one script per test. `generation` is postCompletions;
// `pageAnswer` is egressJson — the chat's detail and the task's status.
let generation
let pageAnswer
let generationCalls
let pageCalls
const realCompletions = browserEgress.postCompletions
const realPageAnswer = browserEgress.egressJson
const realPost = axios.post
const realGet = axios.get
const realAccount = accountManager.getAccount
const transports = { chat: config.chatCreationTransport, completions: config.completionsTransport }
// A video asked for as a stream is kept alive every so often, while it is being made.
const KEEP_ALIVE_MS = 15000

// The generation call's answer, in the shape postCompletions hands one over.
const relayed = (data) => ({ status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' }, data })

test.before(async () => {
  await accountManager._initPromise
  // The media controller picks its account itself: hand it the test's.
  accountManager.getAccount = () => ACCOUNT
  browserEgress.postCompletions = async (context) => { generationCalls += 1; return generation(context) }
  browserEgress.egressJson = async (context) => { pageCalls.push(context); return pageAnswer(context) }
  // qwen.ai is never contacted: nothing in this file may go out directly.
  axios.post = async (url) => { throw new Error(`offline test: no direct POST to ${url}`) }
  axios.get = async (url) => { throw new Error(`offline test: no direct GET to ${url}`) }
})
test.beforeEach(() => {
  accountManager.accountTokens = [ACCOUNT]
  accountManager.isInitialized = true
  createChat = async () => 'chat-1'
  generation = async () => { throw new Error('offline test: no generation scripted') }
  pageAnswer = async () => { throw new Error('offline test: no whole-answer call scripted') }
  generationCalls = 0
  pageCalls = []
  resetChatChallengeBreaker()
  setChatChallengeClockForTests(() => Date.now())
  // Both flags as prod has them since 2026-11-25.
  config.chatCreationTransport = 'browser'
  config.completionsTransport = 'browser'
  sendChatRequest = async () => ({ status: false, response: null })
  wholeAnswerRetry.setWholeAnswerRetryForTests()
})
test.after(() => {
  browserEgress.postCompletions = realCompletions
  browserEgress.egressJson = realPageAnswer
  axios.post = realPost
  axios.get = realGet
  accountManager.getAccount = realAccount
  Object.assign(config, { chatCreationTransport: transports.chat, completionsTransport: transports.completions })
  setChatChallengeClockForTests(() => Date.now())
  accountManager.destroy()
})

// A body as the egress hands one over: bytes in chunks, as the relay's Readable carries them
// (Readable.from keeps strings as strings, and the readers decode bytes).
const body = (chunks) => Readable.from(chunks.map(chunk => Buffer.from(chunk)))

/** What a client that left is left with: nothing — no answer, no frame, no end. */
const nothingAnswered = (res, logs) => {
  assert.equal(res.body, null, 'no JSON is built for a client that is gone')
  assert.equal(res.output, '', 'no frame is written for a client that is gone')
  assert.equal(res.writableEnded, false, 'nothing is ended for a client that is gone')
  assert.deepEqual(logs, [], 'a client leaving is not a failure')
}

describe('an image, /v1/chat/completions: the client leaving takes the generation with it', () => {
  it('mid-answer, as Bun reports it: the relay is closed at once; no lookup, no answer, no error line', HELD, async context => {
    const logs = recordedErrors(context)
    const stats = recordedStats(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    const upstream = held([drawing()])
    generation = () => relayed(upstream.stream)

    const handling = handleImageVideoCompletion(req, res)
    try {
      await afterHead(upstream, handling)
      assert.equal(upstream.stream.destroyed, false, 'the answer is read while the client is there')
      req.leave()
      await handling
    } finally {
      await endHeld(upstream, handling)
    }

    assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
    assert.equal(generationCalls, 1, 'the generation was asked for once')
    assert.deepEqual(pageCalls, [], 'nothing is looked up for a client that is gone')
    nothingAnswered(res, logs)
    assert.deepEqual(stats, [])
  })

  it('mid-answer, as Node reports it: the same, by the socket\'s close', HELD, async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    const upstream = held([drawing()])
    generation = () => relayed(upstream.stream)

    const handling = handleImageVideoCompletion(req, res)
    try {
      await afterHead(upstream, handling)
      req.leave('events')
      await handling
    } finally {
      await endHeld(upstream, handling)
    }

    assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
    assert.deepEqual(pageCalls, [])
    nothingAnswered(res, logs)
  })

  it('while the answer says nothing — a model still drawing: the relay is closed without a next piece to stop at',
    HELD, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: T2I })
      const res = bunResponse()
      const upstream = held([])
      generation = () => relayed(upstream.stream)

      const handling = handleImageVideoCompletion(req, res)
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
      nothingAnswered(res, logs)
    })

  it('while the chat is being made: the generation is not sent at all', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    createChat = async () => { req.leave(); return 'chat-1' }

    await handleImageVideoCompletion(req, res)

    assert.equal(generationCalls, 0, 'no generation for a client that is gone')
    assert.deepEqual(pageCalls, [])
    nothingAnswered(res, logs)
  })

  it('a client already gone when the request is handled: neither the chat nor the generation is asked for', async context => {
    const logs = recordedErrors(context)
    let chats = 0
    createChat = async () => { chats += 1; return 'chat-1' }
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    req.leave()

    await handleImageVideoCompletion(req, res)

    assert.equal(chats, 0)
    assert.equal(generationCalls, 0)
    nothingAnswered(res, logs)
  })

  it('a client already gone when the relay\'s answer arrives: the answer is closed before a byte of it is read',
    HELD, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: T2I })
      const res = bunResponse()
      const upstream = held([picture('https://cdn.example.com/never-read.png')])
      generation = () => {
        // Gone by the time the relay answers — by the address alone: whoever asks the
        // socket from here on is told at once, without waiting for the watch's next ask.
        req.leave()
        return relayed(upstream.stream)
      }

      const handling = handleImageVideoCompletion(req, res)
      try {
        await handling
        assert.equal(upstream.stream.destroyed, true, 'closed before its picture was read')
        nothingAnswered(res, logs)
      } finally {
        await endHeld(upstream, handling)
      }
    })

  it('as the answer ends — the picture in hand, and nobody left for it: nothing is answered', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    // The last frame carries the picture; the client goes as it is handed over, by the
    // address alone — which nothing asks about until the read is done.
    const upstream = Readable.from((async function* () {
      yield Buffer.from(picture())
      req.leave()
    })())
    generation = () => relayed(upstream)

    await handleImageVideoCompletion(req, res)

    nothingAnswered(res, logs)
  })

  it('while the link is looked for in the chat: the lookups stop, and the request does not sit out their pauses',
    SOON, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: T2I })
      const res = bunResponse()
      // The answer ends with no picture in it: the link is looked for in the chat, five times.
      generation = () => relayed(body([drawing()]))
      pageAnswer = async () => ({ status: 200, data: { success: true, data: { chat: { history: { messages: {} } } } } })

      const handling = handleImageVideoCompletion(req, res)
      await until(() => pageCalls.length === 1, 'the first lookup in the chat')
      req.leave()
      await handling

      assert.equal(pageCalls.length, 1, 'one lookup was out when the client left; no second one')
      nothingAnswered(res, logs)
    })

  it('a generation that really fails, the client staying: still an error, still logged', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    const broken = Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
    generation = () => relayed(new Readable({
      read() { this.destroy(broken) }
    }))

    await handleImageVideoCompletion(req, res)

    assert.equal(res.statusCode, 500, 'the failure is the client\'s')
    assert.ok(logs.length > 0, 'and it is logged as one')
  })

  it('a road that breaks as the client leaves is the leaving too: nothing is logged for a client that is gone',
    HELD, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: T2I })
      const res = bunResponse()
      // The transport goes under the answer before anything asks the socket — under Bun the
      // leaving is reported by nothing else, and the watch asks every quarter of a second.
      const broken = Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
      generation = () => relayed(new Readable({
        read() {
          req.leave()
          this.destroy(broken)
        }
      }))

      await handleImageVideoCompletion(req, res)

      nothingAnswered(res, logs)
    })

  it('the same of a video\'s answer, read whole', HELD, async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    const broken = Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
    generation = () => relayed(Readable.from((async function* () {
      yield Buffer.from(taskAnswer())
      req.leave()
      throw broken
    })()))

    await handleOpenAIVideoGeneration(req, res)

    assert.deepEqual(pageCalls, [], 'the task is not polled for a client that is gone')
    nothingAnswered(res, logs)
  })

  it('the same image, the client staying: the picture, as before', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    generation = () => relayed(body([drawing(), picture()]))

    await handleImageVideoCompletion(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)
    assert.deepEqual(pageCalls, [])
    assert.deepEqual(logs, [])
  })
})

describe('an image, the OpenAI endpoints', () => {
  it('/v1/images/generations: the client leaving mid-answer closes the relay; no JSON, no error line', HELD, async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    const upstream = held([drawing()])
    generation = () => relayed(upstream.stream)

    const handling = handleOpenAIImagesGeneration(req, res)
    try {
      await afterHead(upstream, handling)
      req.leave()
      await handling
    } finally {
      await endHeld(upstream, handling)
    }

    assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
    assert.equal(generationCalls, 1)
    nothingAnswered(res, logs)
  })

  it('/v1/images/generations: the client leaving while the chat is being made sends no generation', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    createChat = async () => { req.leave(); return 'chat-1' }

    await handleOpenAIImagesGeneration(req, res)

    assert.equal(generationCalls, 0)
    nothingAnswered(res, logs)
  })

  it('/v1/images/generations, the client staying: the picture, as before', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    generation = () => relayed(body([picture()]))

    await handleOpenAIImagesGeneration(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data, [{ url: IMAGE_URL }])
    assert.deepEqual(logs, [])
  })

  // An edit with the picture given by its link: nothing is uploaded, the generation is the same relay.
  const EDIT = { model: MODEL, prompt: 'make it red', image: 'https://cdn.example.com/src.png' }

  it('/v1/images/edits: the client leaving mid-answer closes the relay; no JSON, no error line', HELD, async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: EDIT })
    const res = bunResponse()
    const upstream = held([drawing()])
    generation = () => relayed(upstream.stream)

    const handling = handleOpenAIImagesEdit(req, res)
    try {
      await afterHead(upstream, handling)
      req.leave()
      await handling
    } finally {
      await endHeld(upstream, handling)
    }

    assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
    assert.equal(generationCalls, 1)
    nothingAnswered(res, logs)
  })

  it('/v1/images/edits: the client leaving while the chat is being made sends no generation', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: EDIT })
    const res = bunResponse()
    createChat = async () => { req.leave(); return 'chat-1' }

    await handleOpenAIImagesEdit(req, res)

    assert.equal(generationCalls, 0)
    nothingAnswered(res, logs)
  })

  it('/v1/images/edits, the client staying: the edited picture, as before', async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: EDIT })
    const res = bunResponse()
    generation = () => relayed(body([picture()]))

    await handleOpenAIImagesEdit(req, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data, [{ url: IMAGE_URL }])
    assert.deepEqual(logs, [])
  })
})

describe('a video', () => {
  // The task's status, as the page answers it: not done, until a test says otherwise.
  const running = () => ({ status: 200, data: { task_status: 'running' } })
  const finished = () => ({ status: 200, data: { task_status: 'success', content: VIDEO_URL } })

  it('/v1/videos: the client leaving while the answer is being read whole closes the relay; the task is never polled',
    HELD, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: PROMPT })
      const res = bunResponse()
      // Half of the task's id is in; the rest is still coming.
      const upstream = held(['{"success":true,"data":{"task_id":"task-'])
      generation = () => relayed(upstream.stream)

      const handling = handleOpenAIVideoGeneration(req, res)
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      assert.equal(upstream.stream.destroyed, true, 'the relay was closed')
      assert.equal(generationCalls, 1, 'and the answer is not asked for a second time')
      assert.deepEqual(pageCalls, [], 'the task is not polled for a client that is gone')
      nothingAnswered(res, logs)
    })

  it('/v1/videos: the client leaving during a poll of the task ends the request there, with no pause after it',
    SOON, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: PROMPT })
      const res = bunResponse()
      generation = () => relayed(body([taskAnswer()]))
      pageAnswer = async () => { req.leave(); return running() }

      await handleOpenAIVideoGeneration(req, res)

      assert.equal(pageCalls.length, 1, 'the poll that was out when the client left is the last')
      nothingAnswered(res, logs)
    })

  it('/v1/videos: the client leaving between two polls ends the request at once, not twenty seconds later',
    SOON, async context => {
      const logs = recordedErrors(context)
      const req = liveRequest({ body: PROMPT })
      const res = bunResponse()
      generation = () => relayed(body([taskAnswer()]))
      pageAnswer = async () => running()

      const handling = handleOpenAIVideoGeneration(req, res)
      await until(() => pageCalls.length === 1, 'the first poll of the task')
      req.leave()
      await handling

      assert.equal(pageCalls.length, 1, 'the task is not polled again for a client that is gone')
      nothingAnswered(res, logs)
    })

  it('/v1/chat/completions with a video asked for as a stream: the keep-alive goes with the client, and no error frame follows',
    SOON, async context => {
      const logs = recordedErrors(context)
      // The keep-alive is counted where it is made, and where it is dropped. (The watch of
      // the client asks on an interval of its own, utils/client-gone.js: not this one.)
      const keepAlives = new Set()
      const realSetInterval = globalThis.setInterval
      const realClearInterval = globalThis.clearInterval
      context.mock.method(globalThis, 'setInterval', (...args) => {
        const timer = realSetInterval(...args)
        if (args[1] === KEEP_ALIVE_MS) keepAlives.add(timer)
        return timer
      })
      context.mock.method(globalThis, 'clearInterval', (timer) => {
        keepAlives.delete(timer)
        realClearInterval(timer)
      })
      const req = liveRequest({ body: { ...T2V, stream: true } })
      const res = bunResponse()
      generation = () => relayed(body([taskAnswer()]))
      pageAnswer = async () => running()

      const handling = handleImageVideoCompletion(req, res)
      await until(() => pageCalls.length === 1, 'the first poll of the task')
      assert.equal(keepAlives.size, 1, 'the keep-alive runs while the video is being made')
      req.leave()
      await handling

      assert.equal(keepAlives.size, 0, 'the keep-alive does not outlive the client')
      assert.equal(pageCalls.length, 1, pageCalls.map(call => call.url).join(' ; '))
      assert.doesNotMatch(res.output, /"error"/, 'no error frame is written for a client that is gone')
      assert.doesNotMatch(res.output, /\[DONE\]/)
      assert.deepEqual(logs, [])
    })

  it('the same video, the client staying: polled to its end, as before', async context => {
    const logs = recordedErrors(context)
    // The pause between two polls is the task's own, twenty seconds: the clock is the test's here.
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    generation = () => relayed(body([taskAnswer()]))
    pageAnswer = async () => (pageCalls.length === 1 ? running() : finished())

    const handling = handleOpenAIVideoGeneration(req, res)
    try {
      for (let i = 0; i < 200 && !res.writableEnded; i++) {
        await new Promise(resolve => setImmediate(resolve))
        context.mock.timers.tick(20000)
      }
      await handling
    } finally {
      context.mock.timers.reset()
    }

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data[0].url, VIDEO_URL)
    assert.equal(pageCalls.length, 2, 'not done, then done')
    assert.equal(generationCalls, 1)
    assert.deepEqual(logs, [])
  })

  it('a video asked for as a stream, the client staying: the video in one frame, and the keep-alive dropped',
    async context => {
      const logs = recordedErrors(context)
      const keepAlives = new Set()
      const realSetInterval = globalThis.setInterval
      const realClearInterval = globalThis.clearInterval
      context.mock.method(globalThis, 'setInterval', (...args) => {
        const timer = realSetInterval(...args)
        if (args[1] === KEEP_ALIVE_MS) keepAlives.add(timer)
        return timer
      })
      context.mock.method(globalThis, 'clearInterval', (timer) => {
        keepAlives.delete(timer)
        realClearInterval(timer)
      })
      const req = liveRequest({ body: { ...T2V, stream: true } })
      const res = bunResponse()
      generation = () => relayed(body([taskAnswer()]))
      pageAnswer = async () => finished()

      await handleImageVideoCompletion(req, res)

      assert.equal(res.statusCode, 200)
      assert.equal(keepAlives.size, 0, 'the keep-alive is dropped once the video is there')
      assert.match(res.output, new RegExp(VIDEO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.deepEqual(logs, [])
    })
})

describe('what the leaving must not cost', () => {
  it('no second attempt: a client leaving in the pause before a retried generation does not get the retry', SOON, async context => {
    const logs = recordedErrors(context)
    const req = liveRequest({ body: PROMPT })
    const res = bunResponse()
    // The video's answer as qwen.ai gives it an internal error, which is asked for again once.
    generation = () => relayed(body([JSON.stringify({
      success: false, data: { code: 'Bad_Request', details: 'internal error', request_id: 'r1' }
    })]))

    const handling = handleOpenAIVideoGeneration(req, res)
    await until(() => generationCalls === 1, 'the first generation')
    req.leave()
    await handling

    assert.equal(generationCalls, 1, 'the retry is not sent for a client that is gone')
    // qwen.ai's own error is in the log, where it always was; the leaving is in none of them.
    const ofTheLeaving = logs.filter(call => ['图片/视频请求失败', '图片/视频主流程异常', 'OpenAI 视频生成端点处理失败'].includes(call[0]))
    assert.deepEqual(ofTheLeaving, [])
    assert.equal(res.body, null)
    assert.equal(res.output, '')
  })

  it('a probe of the chat breaker that a leaving client cut is given back: the next request goes through', { timeout: 15000 }, async context => {
    recordedErrors(context)
    let now = Date.now()
    setChatChallengeClockForTests(() => now)
    try {
      // Three challenges open the breaker: the request that follows is refused without a generation.
      for (let i = 0; i < 3; i++) {
        generation = () => relayed(body([challenge()]))
        await handleImageVideoCompletion(liveRequest({ body: T2I }), bunResponse())
      }
      const shut = bunResponse()
      await handleImageVideoCompletion(liveRequest({ body: T2I }), shut)
      assert.equal(shut.statusCode, 503, 'the breaker is open')
      assert.equal(generationCalls, 3, 'nothing is sent while it is')
      now += 60_000

      // The request that follows is the one probe — and its client leaves before qwen.ai
      // answered it. (Answered, a probe closes by itself: that is not what is at stake.)
      const req = liveRequest({ body: T2I })
      const upstream = held([])
      generation = () => relayed(upstream.stream)
      const handling = handleImageVideoCompletion(req, bunResponse())
      try {
        await afterHead(upstream, handling)
        req.leave()
        await handling
      } finally {
        await endHeld(upstream, handling)
      }

      // Inside the window that probe armed, the next request must go through:
      // the breaker is not left armed on a probe that never got its answer.
      now += 30_000
      generation = () => relayed(body([picture()]))
      const next = bunResponse()
      await handleImageVideoCompletion(liveRequest({ body: T2I }), next)
      assert.equal(next.statusCode, 200, 'the probe was given back with its client')
    } finally {
      setChatChallengeClockForTests(() => Date.now())
    }
  })
})

describe('the direct path reads by the same rule', () => {
  // With the flags off the generation goes out of axios, as before 2026-11-25.
  it('an image out of axios: the client leaving mid-answer closes that answer too', HELD, async context => {
    const logs = recordedErrors(context)
    config.completionsTransport = 'direct'
    const req = liveRequest({ body: T2I })
    const res = bunResponse()
    const upstream = held([drawing()])
    axios.post = async () => ({ status: 200, statusText: 'OK', headers: {}, data: upstream.stream })

    const handling = handleImageVideoCompletion(req, res)
    try {
      await afterHead(upstream, handling)
      req.leave()
      await handling
    } finally {
      await endHeld(upstream, handling)
      axios.post = async (url) => { throw new Error(`offline test: no direct POST to ${url}`) }
    }

    assert.equal(upstream.stream.destroyed, true, 'the answer was closed')
    assert.equal(generationCalls, 0, 'nothing went through the page')
    nothingAnswered(res, logs)
  })
})

describe('a whole answer asked for once more (Qwen2API-jk9): a client that leaves takes its retry with it', () => {
  // The first attempt of a request without a stream dies before a byte reached the client, and
  // the request is made once more, whole (src/utils/whole-answer-retry.js). What sendChatRequest
  // answers is the test's here, call by call — so the client can leave between them, and inside
  // one — as the text paths of tests/client-gone.test.js answer it for their handlers.
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  const answer = content => frame({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })
  const finished = () => [
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
    'data: [DONE]\n\n'
  ]
  const fullAnswer = (content = 'pong') => body([answer(content), ...finished()])
  // An answer with nothing but a thought in it: what makes each handler ask once more on its own —
  // the empty-output compensation of chat.js, the gate's correcting round of anthropic.js.
  const thoughtOnly = () => body([frame({ choices: [{ delta: { phase: 'think', content: 'hm' }, finish_reason: null }] }), ...finished()])
  // An answer that begins and then dies under its reader with `error`.
  const dyingWith = (error, content = 'cut ') => Readable.from((async function* () {
    yield Buffer.from(answer(content))
    throw error
  })())
  // The relay's failure under a reader, as browser-egress.js#relayFailure makes it.
  const broke = (workerCode, code = 'ECONNRESET') =>
    Object.assign(new Error(`signin-worker egress: ${workerCode}`), { code, workerCode })
  // The worker's word for a chats/new its page did not answer in time, on the category the client gets.
  const timedOut = (workerCode = 'egress_timeout') =>
    Object.assign(new ChatCreationError('upstream_transport_error', 503), { workerCode })
  const SENT = { currentAccount: { ...ACCOUNT } }
  // An attempt as sendChatRequest hands it over. Each is made for the call it answers: a stream is read once.
  const DIED = () => ({ status: true, response: dyingWith(broke('egress_failed')), ...SENT })
  const WHOLE = () => ({ status: true, response: fullAnswer(), ...SENT })
  const REQUEST = { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
  // The two surfaces of a whole answer, as their controllers are asked once the middleware is through —
  // on the request the test gives, whose client is the test's to take away. `extra` is what else the
  // middleware sets for a request (TOOLS), over what a plain one gets.
  const SURFACES = [
    {
      name: '/v1/chat/completions',
      ask: (req, res, extra = {}) => handleChatCompletion(Object.assign(req, {
        body: { ...REQUEST }, enable_thinking: false, enable_web_search: false, has_tools: false,
        allowed_tool_names: [], upload_account: SENT.currentAccount, ...extra
      }), res),
      answered: res => res.body.choices[0].message.content
    },
    {
      name: '/v1/messages',
      ask: (req, res, extra = {}) => handleAnthropicMessages(Object.assign(req, { body: { ...REQUEST }, ...extra }), res),
      answered: res => res.body.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }
  ]
  // What the middleware sets for a request with tools, on each surface.
  const TOOLS = {
    '/v1/chat/completions': {
      has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'],
      body: { ...REQUEST, tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }] }
    },
    '/v1/messages': {
      body: { ...REQUEST, tools: [{ name: 'get_time', input_schema: { type: 'object', properties: {} } }] }
    }
  }
  // What the whole retry said while the test ran, as the logger was asked to print it.
  const retryLines = context => {
    const said = []
    for (const level of ['warn', 'info']) context.mock.method(logger, level, (...args) => said.push([level, ...args]))
    return () => said
      .filter(([, message]) => String(message).startsWith('非流式整体重试'))
      .map(([level, message, tag]) => `${level} ${tag} ${message}`)
  }
  // sendChatRequest answering from `answers`, one function per call, and a record of what it was asked.
  const answering = answers => {
    const asked = []
    sendChatRequest = async (...args) => {
      asked.push(args)
      assert.ok(answers.length, 'more requests than the test has answers for')
      return answers.shift()(...args)
    }
    return asked
  }
  // `handling`, or a rejection once `ms` passed: a request that never ends fails its test instead of hanging it.
  const within = (handling, ms, what) => {
    let timer
    return Promise.race([
      Promise.resolve(handling).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not within ${ms} ms: ${what}`)), ms) })
    ])
  }
  // What a wait inside a test leaves before the test's own deadline (HELD, SOON): a request that does not
  // end is reported as the assertion that waited for it, a second before the runner's clock runs out — the
  // watch of the client asks its socket every quarter of a second, so what is left is enough for it.
  const BEFORE = { held: HELD.timeout - 2000, soon: SOON.timeout - 1000 }
  // The pauses the retry asked for while a test ran — to be none, where the test says none is due.
  const noPause = () => {
    const pauses = []
    wholeAnswerRetry.setWholeAnswerRetryForTests({ pause: async ms => { pauses.push(ms) } })
    return pauses
  }
  const BEGAN = reason => [`warn REQUEST 非流式整体重试 (原因: ${reason})`]
  const DELIVERED = reason => [...BEGAN(reason), `info REQUEST 非流式整体重试成功 (原因: ${reason})`]

  for (const surface of SURFACES) {
    it(`${surface.name}: the client leaves while the retried answer is being read — that answer is closed at once; no error line, nothing answered, and no third request`, HELD, async context => {
      const logs = recordedErrors(context)
      const lines = retryLines(context)
      const req = liveRequest()
      const res = bunResponse()
      const retry = held([answer('never read')])
      const asked = answering([() => DIED(), () => ({ ...WHOLE(), response: retry.stream })])

      const handling = surface.ask(req, res)
      try {
        await afterHead(retry, handling)
        assert.deepEqual(lines(), BEGAN('upstream_broke, egress_failed'), 'the retry was begun')
        assert.equal(retry.stream.destroyed, false, 'the retried answer is read while the client is there')
        req.leave()
        await within(handling, BEFORE.held, 'the request ending')
      } finally {
        // An assertion that failed above must end as itself: with the client gone the request ends at once.
        req.leave()
        await endHeld(retry, handling)
      }

      assert.equal(retry.stream.destroyed, true, 'the retried answer was closed')
      assert.equal(asked.length, 2, 'a second request, and no third')
      nothingAnswered(res, logs)
      assert.deepEqual(lines(), BEGAN('upstream_broke, egress_failed'), 'begun, and not delivered: there was nobody to deliver to')
    })

    it(`${surface.name}: the client leaves in the pause after a chats/new that timed out — the request is not asked again, and nothing is said of a retry`, SOON, async context => {
      const logs = recordedErrors(context)
      const lines = retryLines(context)
      const req = liveRequest()
      const res = bunResponse()
      let paused
      const inPause = new Promise(resolve => { paused = resolve })
      wholeAnswerRetry.setWholeAnswerRetryForTests({ pause: () => { paused(); return new Promise(() => {}) } })
      const asked = answering([() => { throw timedOut() }, () => WHOLE()])

      const handling = surface.ask(req, res)
      await within(inPause, BEFORE.soon, 'the pause before the retry')
      req.leave()
      await within(handling, BEFORE.soon, 'the request ending')

      assert.equal(asked.length, 1, 'the request was not asked again')
      nothingAnswered(res, logs)
      assert.deepEqual(lines(), [], 'a retry that never began is not spoken of')
    })

    for (const [kind, died] of [
      ['upstream_broke', () => DIED()],
      ['upstream_5xx', () => ({ status: false, response: null, failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null }, upstreamStatus: 502 })],
      ['chats_new_timeout', () => { throw timedOut() }]
    ]) {
      it(`${surface.name}: a client gone by the time its first attempt died of ${kind} is not answered, and nothing is logged or said of it`, SOON, async context => {
        const logs = recordedErrors(context)
        const lines = retryLines(context)
        const req = liveRequest()
        const res = bunResponse()
        const pauses = noPause()
        const asked = answering([
          () => { req.leave(); return died() },
          () => assert.fail('the request is not asked again for a client that is gone')
        ])

        await within(surface.ask(req, res), BEFORE.soon, 'the request ending')

        assert.equal(asked.length, 1)
        assert.deepEqual(pauses, [], 'no pause is sat out for a client that is gone')
        nothingAnswered(res, logs)
        assert.deepEqual(lines(), [])
      })
    }

    it(`${surface.name}: one retry per request — a retry that dies too is answered as that failure always was, and no third request is made`, SOON, async context => {
      const lines = retryLines(context)
      for (const [kind, died, again] of [
        ['upstream_broke', () => DIED(), () => DIED()],
        // The retry's refusal is its own: another status of qwen.ai's, and what the client gets is that one's.
        ['upstream_5xx', () => ({ status: false, response: null, failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null }, upstreamStatus: 502 }),
          () => ({ status: false, response: null, failure: { rateLimited: false, overloaded: false, status: 503, retryAfter: null }, upstreamStatus: 503 })],
        ['chats_new_timeout', () => { throw timedOut() }, () => { throw timedOut() }]
      ]) {
        const pauses = []
        wholeAnswerRetry.setWholeAnswerRetryForTests({ pause: async ms => { pauses.push(ms) } })
        const res = bunResponse()
        const asked = answering([died, again, () => assert.fail(`${kind}: no third request`)])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${kind})`)

        assert.equal(asked.length, 2, `${kind}: a second request, and no third`)
        assert.equal(res.statusCode,
          kind === 'chats_new_timeout' ? 503 : kind === 'upstream_5xx' ? 503 : surface.name === '/v1/messages' ? 500 : 502,
          `${kind}: ${JSON.stringify(res.body)}`)
        // One pause, before the one retry: the retry's own timeout is not waited for again.
        assert.deepEqual(pauses, kind === 'chats_new_timeout' ? [2000] : [], kind)
      }
      assert.deepEqual(lines(), [
        ...BEGAN('upstream_broke, egress_failed'), ...BEGAN('upstream_5xx, 502'), ...BEGAN('chats_new_timeout')
      ], 'begun three times over three requests, and delivered never')
    })

    it(`${surface.name}: the client leaves while the retried chats/new is out, and that one is refused too — nothing is answered for a client that is gone`, SOON, async context => {
      const logs = recordedErrors(context)
      const lines = retryLines(context)
      const req = liveRequest()
      const res = bunResponse()
      const asked = answering([() => DIED(), () => { req.leave(); throw timedOut('page_closed') }])

      await within(surface.ask(req, res), BEFORE.soon, 'the request ending')

      assert.equal(asked.length, 2, 'a second request, and no third')
      nothingAnswered(res, logs)
      assert.deepEqual(lines(), BEGAN('upstream_broke, egress_failed'))
    })

    it(`${surface.name}: an answer whose connection went under it, on a transport with no worker's word on it, is asked again — and the line names the code`, SOON, async context => {
      const logs = recordedErrors(context)
      const lines = retryLines(context)
      const CUT = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNREFUSED', 'EAI_AGAIN']
      // The code as the transport gives it, on the error or on its cause; and the cut that names itself in its words alone.
      const cuts = [
        ...CUT.map(code => [code, () => Object.assign(new Error('scripted'), { code })]),
        ['ECONNRESET', () => new Error('scripted', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) })],
        ['unknown', () => new Error('other side closed')]
      ]
      for (const [named, cut] of cuts) {
        const res = bunResponse()
        const asked = answering([() => ({ ...DIED(), response: dyingWith(cut()) }), () => WHOLE()])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${named})`)

        assert.equal(res.statusCode, 200, `${named}: ${JSON.stringify(res.body)}`)
        assert.equal(surface.answered(res), 'pong', named)
        assert.equal(asked.length, 2, named)
      }
      assert.deepEqual(lines().filter(line => line.startsWith('warn')), cuts.map(([named]) => `warn REQUEST 非流式整体重试 (原因: network_error, ${named})`))
      assert.deepEqual(logs, [])
    })

    it(`${surface.name}: what is not qwen.ai's or the road's break is not asked again — the relay's other words, and the application's own failures`, SOON, async context => {
      // Each of these is answered with a failure of its own, and says so in an error line: they are the point, not noise to read.
      context.mock.method(logger, 'error', () => {})
      context.mock.method(accountManager, 'recordAccountQuotaExhausted', () => {})
      const lines = retryLines(context)
      // The relay's words on a failure that is its own; a fault of the application's; a quota the first frame carried.
      const NOT = [
        ...['relay_silent', 'relay_closed', 'relay_malformed', 'relay_error', 'egress_timeout', 'page_fault',
          'account_removed', 'worker_unreachable'].map(code => [code, () => dyingWith(broke(code, code === 'relay_silent' || code === 'egress_timeout' ? 'ETIMEDOUT' : 'ECONNRESET'))]),
        ['a parser', () => dyingWith(new SyntaxError('Unexpected token } in JSON at position 3'))],
        ['a bug', () => dyingWith(new TypeError('上游响应不是可读取的异步流'))],
        ['an unsaid error', () => dyingWith(new Error('scripted'))],
        ['the quota', () => body([frame({ success: false, data: { code: 'RateLimited', details: "You've reached the upper limit for today's usage." } })])]
      ]
      for (const [named, cut] of NOT) {
        const res = bunResponse()
        const asked = answering([() => ({ ...DIED(), response: cut() }), () => assert.fail(`${named}: the request is not asked again`)])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${named})`)

        assert.equal(asked.length, 1, named)
        assert.ok(res.statusCode >= 400, `${named}: ${res.statusCode} ${JSON.stringify(res.body)}`)
        if (named === 'the quota') assert.equal(res.statusCode, 429, 'the quota is the quota, as before')
      }
      assert.deepEqual(lines(), [])
    })

    it(`${surface.name}: after a chats/new the worker gave up on the request waits two seconds before it is asked again`, SOON, async context => {
      const logs = recordedErrors(context)
      const lines = retryLines(context)
      const pauses = []
      wholeAnswerRetry.setWholeAnswerRetryForTests({ pause: async ms => { pauses.push(ms) } })
      const asked = answering([() => { throw timedOut() }, () => WHOLE()])
      const res = bunResponse()

      await within(surface.ask(liveRequest(), res), BEFORE.soon, 'the request ending')

      assert.equal(surface.answered(res), 'pong')
      assert.equal(asked.length, 2)
      assert.equal(wholeAnswerRetry.CHATS_NEW_TIMEOUT_PAUSE_MS, 2000)
      assert.deepEqual(pauses, [2000])
      assert.deepEqual(lines(), DELIVERED('chats_new_timeout'))
      assert.deepEqual(logs, [])
    })

    it(`${surface.name}: only the worker's egress_timeout on chats/new is asked again — a chats/new that failed with no such word on it is not`, SOON, async context => {
      const lines = retryLines(context)
      const pauses = noPause()
      // How else a chats/new can fail, and the status the client gets for it, as it always did.
      const NOT = [
        ['the category alone, as a direct transport leaves it', () => { throw new ChatCreationError('upstream_transport_error', 503) }, 503],
        ['page_closed', () => { throw timedOut('page_closed') }, 503],
        ['a refused session', () => { throw new ChatCreationError('upstream_session_unauthorized', 502) }, 502],
        ['a challenge', () => { throw new ChatCreationError('upstream_waf_challenge', 503) }, 503],
        ['an error of the application\'s own', () => { throw new Error('scripted') }, 500]
      ]
      for (const [named, died, status] of NOT) {
        const res = bunResponse()
        const asked = answering([died, () => assert.fail(`${named}: the request is not asked again`)])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${named})`)

        assert.equal(asked.length, 1, named)
        assert.equal(res.statusCode, status, `${named}: ${JSON.stringify(res.body)}`)
      }
      assert.deepEqual(pauses, [], 'a chats/new that did not time out is not waited for')
      assert.deepEqual(lines(), [])
    })

    it(`${surface.name}: qwen.ai's status on the head of completions is asked again from 500 up — not below, not the 429, and not a refusal that names no status`, SOON, async context => {
      const lines = retryLines(context)
      const refusal = (upstreamStatus) => ({
        status: false, response: null, failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null },
        ...(upstreamStatus === undefined ? {} : { upstreamStatus })
      })
      for (const [upstreamStatus, again] of [[500, true], [502, true], [599, true], [499, false], [429, false], [403, false], [undefined, false], ['502', false]]) {
        const said = lines().length
        const res = bunResponse()
        const asked = answering([() => refusal(upstreamStatus), () => WHOLE()])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${upstreamStatus})`)

        assert.equal(asked.length, again ? 2 : 1, `qwen.ai answered ${upstreamStatus}`)
        assert.equal(res.statusCode, again ? 200 : 502, `qwen.ai answered ${upstreamStatus}: ${JSON.stringify(res.body)}`)
        assert.deepEqual(lines().slice(said), again ? DELIVERED(`upstream_5xx, ${upstreamStatus}`) : [], `qwen.ai answered ${upstreamStatus}`)
      }
      assert.equal(lines().length, 2 * 3, 'three refusals were asked again, each with its two lines')
    })

    it(`${surface.name}: the retry is made while the request is younger than half an answer's silence budget — not on the millisecond it is that old`, SOON, async context => {
      const lines = retryLines(context)
      const budget = wholeAnswerRetry.WHOLE_ANSWER_RETRY_BUDGET_MS
      assert.equal(budget, browserEgress.COMPLETIONS_TIMEOUT_MS / 2)
      assert.equal(budget, 5 * 60 * 1000)
      for (const [age, again] of [[0, true], [budget - 1, true], [budget, false], [budget + 1, false], [6 * 60 * 1000, false]]) {
        let now = 1_000_000
        wholeAnswerRetry.setWholeAnswerRetryForTests({ now: () => now })
        const said = lines().length
        const res = bunResponse()
        // The first attempt dies `age` after the controller began with the request.
        const asked = answering([() => { now += age; return DIED() }, () => WHOLE()])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${age} ms old)`)

        assert.equal(asked.length, again ? 2 : 1, `${age} ms old`)
        assert.equal(res.statusCode, again ? 200 : surface.name === '/v1/messages' ? 500 : 502, `${age} ms old`)
        assert.deepEqual(lines().slice(said), again ? DELIVERED('upstream_broke, egress_failed') : [], `${age} ms old`)
      }
    })

    it(`${surface.name}: the retry is the request itself again — the same body, the same options`, SOON, async context => {
      const asked = answering([() => DIED(), () => WHOLE()])
      const res = bunResponse()

      await within(surface.ask(liveRequest(), res), BEFORE.soon, 'the request ending')

      assert.equal(surface.answered(res), 'pong')
      assert.deepEqual(asked[1], asked[0])
      if (surface.name === '/v1/chat/completions') {
        assert.equal(asked[0][1].currentAccount, SENT.currentAccount, 'the account the request named')
      }
    })

    it(`${surface.name}: the warning of a compacted context is the delivered attempt's — not the one that died before it, and on no answer of failure`, SOON, async context => {
      const HEADER = 'X-Qwen2API-Context-Compacted'
      const res = () => Object.assign(bunResponse(), { removeHeader(name) { delete this.headers[name] } })
      const CUT = { contextCompacted: true, contextSerializedBytes: 90000 }
      const REFUSED = { status: false, response: null, failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null }, upstreamStatus: 502 }
      // The first attempt had its context cut, and died; the retry's was not cut.
      let answered = res()
      answering([() => ({ ...DIED(), ...CUT }), () => ({ ...WHOLE(), contextCompacted: false })])
      await within(surface.ask(liveRequest(), answered), BEFORE.soon, 'the request ending')
      assert.equal(answered.statusCode, 200, JSON.stringify(answered.body))
      assert.equal(answered.headers[HEADER], undefined, 'the warning went with the attempt that earned it')

      // The other way round: the warning of the attempt that is delivered arrives.
      answered = res()
      answering([() => ({ ...DIED(), contextCompacted: false }), () => ({ ...WHOLE(), contextCompacted: true, contextSerializedBytes: 80000 })])
      await within(surface.ask(liveRequest(), answered), BEFORE.soon, 'the request ending')
      assert.equal(answered.statusCode, 200, JSON.stringify(answered.body))
      assert.equal(answered.headers[HEADER], '80000')

      // Both attempts had their context cut: the answer carries the delivered attempt's warning, its own size.
      answered = res()
      answering([() => ({ ...DIED(), ...CUT }), () => ({ ...WHOLE(), contextCompacted: true, contextSerializedBytes: 80000 })])
      await within(surface.ask(liveRequest(), answered), BEFORE.soon, 'the request ending')
      assert.equal(answered.statusCode, 200, JSON.stringify(answered.body))
      assert.equal(answered.headers[HEADER], '80000', 'the delivered attempt\'s, not the one that died')

      // The first attempt had its context cut, and died; the retry is refused: the answer of failure
      // carries no attempt's warning — nothing was answered with a cut context.
      for (const [named, refused, status] of [
        ['on the head of completions', () => REFUSED, 502],
        ['outright, its chats/new', () => { throw timedOut('page_closed') }, 503]
      ]) {
        answered = res()
        answering([() => ({ ...DIED(), ...CUT }), refused])
        await within(surface.ask(liveRequest(), answered), BEFORE.soon, `the request ending (the retry refused ${named})`)
        assert.equal(answered.statusCode, status, `${named}: ${JSON.stringify(answered.body)}`)
        assert.equal(answered.headers[HEADER], undefined, `${named}: the warning of the attempt that died is not the failure's`)
      }
    })

    it(`${surface.name}: a chats/new refused on the handler's own round is not asked again, whatever word the worker puts on it`, SOON, async context => {
      // Each is answered with a failure of its own, and says so in an error line: they are the point, not noise to read.
      context.mock.method(logger, 'error', () => {})
      const lines = retryLines(context)
      const pauses = noPause()
      // The first answer has nothing but a thought in it, and the handler asks once more on its own — the
      // empty-output compensation of chat.js, the gate's correcting round of anthropic.js. That round's chats/new
      // is refused with the very words that on a read of an answer would get the request its whole retry.
      for (const code of ['page_closed', 'browser_error', 'egress_failed', 'egress_timeout']) {
        const res = bunResponse()
        const asked = answering([
          () => ({ ...WHOLE(), response: thoughtOnly() }),
          () => { throw timedOut(code) },
          () => assert.fail(`${code}: the request is not asked again`)
        ])

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${code})`)

        assert.equal(asked.length, 2, `${code}: the handler's own round, and no whole retry`)
        assert.equal(res.statusCode, 503, `${code}: ${JSON.stringify(res.body)}`)
      }
      assert.deepEqual(pauses, [], "no pause is sat out on the handler's own round")
      assert.deepEqual(lines(), [], 'a refused call is not a broken read')
    })

    it(`${surface.name}: a context attachment that failed on the handler's own round is not a broken read, whatever its cause says`, SOON, async context => {
      context.mock.method(logger, 'error', () => {})
      const lines = retryLines(context)
      const pauses = noPause()
      const asked = answering([
        () => ({ ...WHOLE(), response: thoughtOnly() }),
        // The attachment's upload went with the connection — words that on a read of an answer would name a network error.
        () => { throw new ContextExternalizationError(Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })) },
        () => assert.fail('the request is not asked again')
      ])
      const res = bunResponse()

      await within(surface.ask(liveRequest(), res), BEFORE.soon, 'the request ending')

      assert.equal(asked.length, 2, "the handler's own round, and no whole retry")
      // The failure of the attachment as each surface always answered it: the retryable status of a context that was not delivered.
      assert.equal(res.statusCode, surface.name === '/v1/messages' ? 529 : 503, JSON.stringify(res.body))
      assert.deepEqual(pauses, [])
      assert.deepEqual(lines(), [])
    })

    it(`${surface.name} with tools, without a stream: a call refused on the agent's own round is not asked again — nor a context attachment that failed there, whatever its cause says`, SOON, async context => {
      context.mock.method(logger, 'error', () => {})
      const lines = retryLines(context)
      const pauses = noPause()
      // The agent handlers' own round: /v1/chat/completions asks for one where a turn is bare prose that its
      // prompt asks to be wrapped, /v1/messages where a turn has nothing but a thought in it.
      const first = () => ({
        ...WHOLE(), response: surface.name === '/v1/messages' ? thoughtOnly() : body([answer('No tool here'), ...finished()])
      })
      // The attachment of a context asked for with tools may not be compacted away: its failure is the round's to answer.
      const lostUpload = () => { throw new ContextExternalizationError(Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })) }
      for (const [named, refused, status] of [
        ...['page_closed', 'browser_error', 'egress_failed'].map(code => [`a chats/new the worker refused (${code})`, () => { throw timedOut(code) }, 503]),
        ['a context attachment whose upload lost its connection', lostUpload, surface.name === '/v1/messages' ? 529 : 503]
      ]) {
        const res = bunResponse()
        const asked = answering([first, refused, () => assert.fail(`${named}: the request is not asked again`)])

        await within(surface.ask(liveRequest(), res, TOOLS[surface.name]), BEFORE.soon, `the request ending (${named})`)

        assert.equal(asked.length, 2, `${named}: the agent's own round, and no whole retry`)
        assert.equal(res.statusCode, status, `${named}: ${JSON.stringify(res.body)}`)
      }
      assert.deepEqual(pauses, [])
      assert.deepEqual(lines(), [])
    })

    it(`${surface.name}: sendChatRequest answering nothing — undefined, or a rejection with nothing in it — is answered as the failure of the application's own, and not nothing thrown`, SOON, async context => {
      const said = []
      context.mock.method(logger, 'error', (...args) => said.push(args))
      const lines = retryLines(context)
      for (const [named, answers] of [['undefined', () => undefined], ['a rejection with nothing in it', () => Promise.reject(undefined)]]) {
        said.length = 0
        const asked = answering([answers, () => assert.fail(`${named}: nothing was named that a retry could mend`)])
        const res = bunResponse()

        await within(surface.ask(liveRequest(), res), BEFORE.soon, `the request ending (${named})`)

        assert.equal(asked.length, 1, named)
        assert.equal(res.statusCode, 500, `${named}: ${JSON.stringify(res.body)}`)
        // What the controller's catch was handed says what happened: an error that names the call, not undefined.
        const failure = said.filter(args => args[0] === (surface.name === '/v1/messages' ? 'Anthropic Messages 处理错误' : '聊天处理错误')).at(-1)?.[3]
        assert.ok(failure instanceof TypeError, `${named}: a TypeError was thrown back, got ${failure}`)
        assert.match(String(failure.message), /sendChatRequest/, named)
      }
      assert.deepEqual(lines(), [])
    })
  }

  it('the reasons the retry is given for, by the module\'s own account of a failure', () => {
    const reasonFor = wholeAnswerRetry.reasonFor
    const { ClientGoneError } = require('../src/utils/client-gone')
    // A read of the answer that ended in an error, with the worker's word on it.
    for (const code of ['egress_failed', 'page_closed', 'browser_error']) {
      assert.equal(reasonFor({ broke: broke(code) }), `upstream_broke, ${code}`, code)
    }
    for (const code of ['relay_silent', 'relay_closed', 'relay_malformed', 'relay_error', 'egress_timeout', 'page_fault',
      'egress_too_large', 'resident_capacity', 'account_removed', 'worker_unreachable', 'unauthorized']) {
      assert.equal(reasonFor({ broke: broke(code) }), null, code)
      // A worker's word decides alone: the network's code under it does not make it a network error's.
      assert.equal(reasonFor({ broke: broke(code, 'ETIMEDOUT') }), null, `${code}, timed out`)
    }
    // With no worker's word on it: the network's own ways of going.
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE',
      'ECONNREFUSED', 'EAI_AGAIN']) {
      assert.equal(reasonFor({ broke: Object.assign(new Error('scripted'), { code }) }), `network_error, ${code}`, code)
    }
    assert.equal(reasonFor({ broke: new Error('other side closed') }), 'network_error, unknown', 'the words alone, and no code to name')
    assert.equal(reasonFor({ broke: new SyntaxError('Unexpected token') }), null, "the application's own")
    assert.equal(reasonFor({ broke: new ClientGoneError() }), null, 'the client leaving is no failure')
    assert.equal(reasonFor({ broke: new UpstreamResponseError('quota', 'RateLimited') }), null, 'a quota the first frame carried')
    assert.equal(reasonFor({ broke: null }), null)
    // A refused call, or a failure of the application's own, is no break of a read — whatever stands on it.
    for (const code of ['page_closed', 'browser_error', 'egress_failed']) {
      assert.equal(reasonFor({ broke: timedOut(code) }), null, `a chats/new the worker refused (${code})`)
    }
    assert.equal(reasonFor({ broke: new ChatCreationError('upstream_transport_error', 503) }), null, 'a chats/new a direct transport could not make')
    assert.equal(reasonFor({ broke: new UpstreamResponseError('socket hang up', 'upstream_business_error') }), null,
      "the application's verdict on a frame, in the transport's own words")
    assert.equal(reasonFor({ broke: new ContextExternalizationError(Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })) }), null,
      'a context attachment that failed, with the network under it')
    // A broken read is still one: the relay's failure is a plain Error with the worker's word on it; a direct
    // transport's, an Error with the network's code.
    assert.equal(reasonFor({ broke: Object.assign(new Error('signin-worker egress: egress_failed (In-page fetch failed (network_error).)'),
      { code: 'ECONNRESET', workerCode: 'egress_failed' }) }), 'upstream_broke, egress_failed', 'the shape browser-egress.js#relayFailure makes')
    assert.equal(reasonFor({ broke: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), 'network_error, UND_ERR_SOCKET')
    // A request sendChatRequest refused: only with qwen.ai's status of 500 or more on the head.
    assert.equal(reasonFor({ refused: { upstreamStatus: 500 } }), 'upstream_5xx, 500')
    assert.equal(reasonFor({ refused: { upstreamStatus: 599 } }), 'upstream_5xx, 599')
    assert.equal(reasonFor({ refused: { upstreamStatus: 499 } }), null)
    assert.equal(reasonFor({ refused: { upstreamStatus: 429 } }), null)
    assert.equal(reasonFor({ refused: { upstreamStatus: '502' } }), null)
    assert.equal(reasonFor({ refused: { failure: { status: 502 } } }), null, 'a refusal that names no status of qwen.ai\'s')
    assert.equal(reasonFor({ refused: {} }), null)
    // A request sendChatRequest threw: only the worker\'s egress_timeout on a chats/new, on the category the client gets.
    assert.equal(reasonFor({ thrown: timedOut() }), 'chats_new_timeout')
    assert.equal(reasonFor({ thrown: timedOut('page_closed') }), null)
    assert.equal(reasonFor({ thrown: timedOut('browser_error') }), null)
    assert.equal(reasonFor({ thrown: new ChatCreationError('upstream_transport_error', 503) }), null, 'as a direct transport leaves it')
    assert.equal(reasonFor({ thrown: new Error('signin-worker egress: egress_timeout') }), null, 'the word alone, not on a chats/new failure')
    assert.equal(reasonFor({ thrown: null }), null)
  })
})
