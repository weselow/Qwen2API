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
const browserEgress = require('../src/utils/browser-egress.js')
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
      generation = async () => {
        req.leave()
        // The watch asks its socket every quarter of a second: the time to learn of it.
        await new Promise(resolve => setTimeout(resolve, 400))
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
