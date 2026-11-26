'use strict'

// A client that goes away takes its upstream with it, on the runtime of prod
// (Qwen2API-mxs). Offline smoke: the real application under Bun, its completions relayed
// from a stand-in for the signin worker, and a client that breaks off.
//
// Since Qwen2API-3ue.10 the same for images and video: a picture being generated, a
// video task polled — where a client left alone kept a generation going for minutes.
//
// Next to tests/client-gone.test.js and tests/client-gone-media.test.js, which drive
// the handlers with what was measured, this runs the real thing: a real client on a
// real socket, and the stand-in watching the application's side of the relay. No test
// in one process can show a hang-up — the socket never closes under it — and this one
// showed what the tests could not: on Bun 1.3.14 a server reports nothing of its
// client leaving once the request body was read. All it leaves is the socket losing
// its address (utils/client-gone.js).
//
//   node tools/client-gone-smoke.js --runtime <bun> [--tree <dir holding src/server.js>] [--binary <build>]
//
// The application runs under Bun, as on prod; the smoke, and with it the stand-in,
// under Node, as the worker does. Both for one reason: a server on Bun reports nothing
// when its client goes away, so the application has to look for it — and a stand-in
// on Bun would never see the application closing the relay.
//
// Nothing can leave: the stand-in listens on 127.0.0.1, and it is the only address the
// application is given — as the worker, as the chat origin and as the CLI origin. Run it
// in a container without a network, with both runtimes in it:
//
//   FROM oven/bun:1.3.14-debian
//   COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
//
//   docker run --rm --network none -v <repo>:/work -w /work <that image> \
//     node tools/client-gone-smoke.js --runtime bun
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')

const API_KEY = 'client-gone-smoke-key'
// The heavy endpoints take 30 requests a minute, per key (src/middlewares/authorization.js):
// the steps of images and video bring a key of their own, so that the limit is not what
// the smoke measures.
const MEDIA_KEY = 'client-gone-smoke-media-key'
const WORKER_TOKEN = 'client-gone-smoke-worker-token'
const MODEL = 'qwen-smoke-test'
const PROJECT_ROOT = path.resolve(__dirname, '..')
// A long answer on the wire: long enough that a client has time to leave, and that an
// application reading it to the end is told apart from one that closed it.
const LONG_ANSWER = { frames: 80, everyMs: 100 }
// How long after the client left the relay may still be open. The application asks its
// socket every quarter of a second (utils/client-gone.js#ADDRESS_POLL_MS); this leaves
// room for a loaded machine, and is far from the seconds an application that kept
// reading would take.
const CLOSE_WITHIN_MS = 1500
// The models of the two media paths, named as the application tells them by
// (utils/chat-helpers.js#isChatType): the routes pick the image and the video
// controller by the suffix.
const IMAGE_MODEL = 'qwen-smoke-image'
const VIDEO_MODEL = 'qwen-smoke-video'
// What the answers carry: links only, on a host the smoke never asks.
const IMAGE_URL = 'https://cdn.example.invalid/a.png'
const VIDEO_URL = 'https://cdn.example.invalid/v.mp4'
const TASK_ID = 'client-gone-smoke-task'
// A video task is polled every twenty seconds (src/controllers/chat.image.video.js).
// A request left alone polls again on the far side of that pause: waiting it out
// is what tells a request that ended from one still asleep.
const POLL_PAUSE_MS = 20000

const startListener = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const closeListener = async server => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
const until = async (condition, ms, what, detail) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${detail ? `: ${detail()}` : ''}`)
    await delay(10)
  }
}
const readBody = async request => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw ? JSON.parse(raw) : {}
}
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const answerFrame = content => sse({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })
const pictureFrame = content => sse({ choices: [{ delta: { phase: 'image_gen', content }, finish_reason: null }] })
const closingFrames = () => [
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
  'data: [DONE]\n\n'
]

/** What the stand-in answers, one plan per request. `ms` is the wait before a frame. */
const PLANS = {
  // A client that stays: the whole answer, at once. A turn with tools is wrapped the way
  // the agent prompt asks for; a plain answer is not.
  short: ({ wrapped }) => [
    { ms: 0, frame: answerFrame(wrapped ? '<agent_final>pong</agent_final>' : 'pong') },
    ...closingFrames().map(frame => ({ ms: 0, frame }))
  ],
  // An answer in progress: a frame every so often, for a good while.
  long: () => [
    { ms: 0, frame: answerFrame('word ') },
    ...Array.from({ length: LONG_ANSWER.frames }, () => ({ ms: LONG_ANSWER.everyMs, frame: answerFrame('word ') })),
    ...closingFrames().map(frame => ({ ms: LONG_ANSWER.everyMs, frame }))
  ],
  // A model thinking: one frame, then silence — the relay is idle, there is no next frame
  // to stop at.
  silent: () => [
    { ms: 0, frame: answerFrame('hm') },
    { ms: LONG_ANSWER.frames * LONG_ANSWER.everyMs, frame: answerFrame('late') },
    ...closingFrames().map(frame => ({ ms: 0, frame }))
  ],
  // A picture being drawn (Qwen2API-3ue.10): a frame every so often, with no picture in
  // it — the generation goes on for a good while, and never brings a link.
  picture: () => [
    { ms: 0, frame: pictureFrame('drawing') },
    ...Array.from({ length: LONG_ANSWER.frames }, () => ({ ms: LONG_ANSWER.everyMs, frame: pictureFrame('drawing') }))
  ],
  // A picture, for a client that stays: the frame with its link, and the end.
  pictureShort: () => [
    { ms: 0, frame: pictureFrame(`![image](${IMAGE_URL})`) },
    ...closingFrames().map(frame => ({ ms: 0, frame }))
  ],
  // A video's answer: JSON, whole — the task to poll (the controller reads it to its end).
  videoTask: () => [{ ms: 0, frame: JSON.stringify({ success: true, data: { task_id: TASK_ID } }) }]
}
// Which plans answer SSE, and which answer JSON.
const ANSWERS_JSON = new Set(['videoTask'])
// What the page answers the video task's status with: done, with the video — or, for
// a request that is to be left alone, not done.
const TASK_DONE = { task_status: 'success', content: VIDEO_URL }
const TASK_RUNNING = { task_status: 'running' }
let taskStatus = TASK_DONE

async function main() {
  const { values } = parseArgs({ options: {
    tree: { type: 'string' }, binary: { type: 'string' }, runtime: { type: 'string' }
  } })
  const appRoot = values.tree ? path.resolve(values.tree) : PROJECT_ROOT
  const binaryPath = values.binary ? path.resolve(values.binary) : null
  assert.ok(values.runtime, 'Name the Bun that runs the application: --runtime <bun>. On prod it is a Bun server, and the point is what it reports')
  assert.ok(!process.versions.bun,
    'Run the smoke with Node, and the application with --runtime <bun>: a server on Bun never sees its client close the relay, so a stand-in on Bun could not watch it')
  const applicationRuntime = values.runtime

  // Every relay the stand-in served: what it was asked, how it ended.
  const relays = []
  // Every poll of the video task's status the stand-in answered, and when.
  const polls = []
  let plan = { name: 'short', wrapped: false }
  const expires = Math.floor(Date.now() / 1000) + 86400
  // A token of the shape the application parses, and nothing more.
  const tokenFor = label => [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'smoke@example.invalid', label, exp: expires })).toString('base64url'),
    'local-test-signature'
  ].join('.')
  const standIn = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (route === '/session' || route === '/renew') {
      await readBody(request)
      return json(200, { token: tokenFor(route.slice(1)), expiresAt: expires, cookies: [] })
    }
    if (route === '/api/models') {
      request.resume()
      const model = (id, chatType) => ({ id, name: id, info: { meta: { chat_type: [chatType], abilities: {} } } })
      return json(200, { data: [model(MODEL, 't2t'), model(IMAGE_MODEL, 't2i'), model(VIDEO_MODEL, 't2v')] })
    }
    if (route !== '/egress') {
      request.resume()
      return json(404, { error: `Unexpected upstream path: ${route}` })
    }
    const call = await readBody(request)
    if (!call.stream) {
      // A whole-answer call from inside the page (browser-egress.js#egressJson): qwen.ai's
      // status and body as the worker hands them over.
      const pageAnswer = payload => json(200, {
        status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        url: call.url, redirected: false, cookies: []
      })
      const pathname = new URL(call.url, 'http://127.0.0.1').pathname
      if (pathname === '/api/v2/chats/new') return pageAnswer({ success: true, data: { id: 'client-gone-smoke-chat' } })
      // The status of the video task, polled for as long as the request lives.
      if (pathname === `/api/v1/tasks/status/${TASK_ID}`) {
        polls.push(Date.now())
        return pageAnswer(taskStatus)
      }
      return json(404, { error: `Unexpected page call: ${pathname}` })
    }
    // The relay of a completions call, as the worker streams it (signin-worker/server.js#relayEgress):
    // one JSON event a line.
    const record = {
      id: relays.length + 1, plan: plan.name, wrapped: plan.wrapped === true,
      started: Date.now(), sent: 0, closedAt: null, endedAt: null, seen: []
    }
    relays.push(record)
    const since = () => `${Date.now() - record.started} ms`
    record.socketState = () => `destroyed=${request.socket.destroyed} readableEnded=${request.socket.readableEnded} ` +
      `writableEnded=${response.writableEnded} bytesWritten=${request.socket.bytesWritten}`
    // The socket: the application closing the relay arrives as its socket closing. (The
    // worker listens to the same, signin-worker/server.js#relayEgress.)
    for (const event of ['close', 'end', 'error']) {
      request.socket.on(event, () => {
        record.seen.push(`${event} on the socket at ${since()}`)
        if (event === 'close') record.closedAt = Date.now()
      })
    }
    for (const event of ['close', 'finish', 'error']) {
      response.on(event, () => { record.seen.push(`${event} on the response at ${since()}`) })
    }
    const write = event => {
      if (request.socket.destroyed) {
        record.seen.push(`socket.destroyed before a write at ${since()}`)
        return false
      }
      response.write(`${JSON.stringify(event)}\n`)
      return true
    }
    response.writeHead(200, {
      'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no'
    })
    response.flushHeaders()
    write({
      type: 'head', status: 200,
      headers: { 'content-type': ANSWERS_JSON.has(record.plan) ? 'application/json' : 'text/event-stream' }, cookies: []
    })
    for (const step of PLANS[record.plan](record)) {
      await delay(step.ms)
      if (!write({ type: 'chunk', data: Buffer.from(step.frame).toString('base64') })) return
      record.sent += 1
    }
    write({ type: 'end', cookies: [] })
    response.end()
    record.endedAt = Date.now()
  })
  const upstreamPort = await startListener(standIn)
  const upstream = `http://127.0.0.1:${upstreamPort}`

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'qwen-client-gone-smoke-'))
  let application
  let applicationClosed
  let applicationLogs = ''
  try {
    let applicationExecutable = applicationRuntime
    let applicationArguments = ['--no-env-file', path.join(appRoot, 'src/server.js')]
    if (binaryPath) {
      applicationExecutable = path.join(temporaryDirectory, path.basename(binaryPath))
      applicationArguments = []
      await copyFile(binaryPath, applicationExecutable)
      await chmod(applicationExecutable, 0o755)
      await mkdir(path.join(temporaryDirectory, 'data'))
      // A binary reads its accounts from data.json; the session is the stand-in's to give.
      await writeFile(path.join(temporaryDirectory, 'data/data.json'), JSON.stringify({
        accounts: [{ email: 'smoke@example.invalid', password: 'local-test-password', expires, token: tokenFor('data') }]
      }))
      await writeFile(path.join(temporaryDirectory, '.env'), `API_KEY=${API_KEY},${MEDIA_KEY}\n`)
    }
    const portReservation = createServer()
    const servicePort = await startListener(portReservation)
    await closeListener(portReservation)
    const baseUrl = `http://127.0.0.1:${servicePort}`

    // An empty cwd and a minimal environment prevent loading a developer's .env.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(name.toUpperCase())))
    application = spawn(applicationExecutable, applicationArguments, {
      cwd: temporaryDirectory,
      env: {
        ...environment,
        NODE_ENV: 'production',
        ...(binaryPath ? {} : { API_KEY: `${API_KEY},${MEDIA_KEY}` }),
        SERVICE_PORT: String(servicePort),
        LISTEN_ADDRESS: '127.0.0.1',
        DATA_SAVE_MODE: binaryPath ? 'file' : 'none',
        ...(binaryPath ? {} : { ACCOUNTS: `smoke@example.invalid:local-test-password` }),
        ENABLE_CLI: 'false',
        ENABLE_FILE_LOG: 'false',
        LOG_LEVEL: 'INFO',
        CACHE_MODE: 'default',
        // Through the page, as on prod; and no address but the stand-in anywhere.
        QWEN_CHAT_PROXY_URL: upstream,
        QWEN_CLI_PROXY_URL: upstream,
        V2_SESSION_MODE: 'browser',
        SIGNIN_WORKER_URL: upstream,
        SIGNIN_WORKER_TOKEN: WORKER_TOKEN,
        CHAT_CREATION_TRANSPORT: 'browser',
        COMPLETIONS_TRANSPORT: 'browser'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    application.stdout.on('data', chunk => { applicationLogs += chunk })
    application.stderr.on('data', chunk => { applicationLogs += chunk })
    applicationClosed = new Promise(resolve => application.once('close', resolve))
    let spawnError
    application.on('error', error => { spawnError = error })

    let ready = false
    const readinessDeadline = Date.now() + 15000
    while (Date.now() < readinessDeadline && !ready) {
      if (spawnError) throw spawnError
      assert.equal(application.exitCode, null, `Application exited early: ${applicationLogs}`)
      try {
        const response = await fetch(`${baseUrl}/api/getAllAccounts`, {
          headers: { 'x-api-key': API_KEY }, signal: AbortSignal.timeout(1000)
        })
        const payload = await response.json()
        ready = response.ok && payload.data?.length === 1 && payload.data[0].expires === expires
      } catch { /* Not listening yet. */ }
      if (!ready) await delay(100)
    }
    assert.ok(ready, `Application did not become ready: ${applicationLogs}`)
    console.log(`runtime: application on ${binaryPath ? 'a binary of' : 'source under'} Bun ${applicationRuntime}; ` +
      `smoke and stand-in on node ${process.version}`)

    const TOOLS = [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }]
    const requests = [
      { route: '/v1/chat/completions', tools: false, body: extra => ({ model: MODEL, max_tokens: 32, ...extra }) },
      { route: '/v1/chat/completions', tools: true, body: extra => ({ model: MODEL, max_tokens: 32, tools: TOOLS, ...extra }) },
      { route: '/v1/messages', tools: false, body: extra => ({ model: MODEL, max_tokens: 32, ...extra }) },
      { route: '/v1/messages', tools: true, body: extra => ({ model: MODEL, max_tokens: 32, tools: [{ name: 'get_time', input_schema: { type: 'object', properties: {} } }], ...extra }) }
    ]
    const label = (request, stream) => `${request.route} stream=${stream}${request.tools ? ' tools' : ''}`
    const send = (request, stream, signal) => fetch(`${baseUrl}${request.route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request.body({
        stream, messages: [{ role: 'user', content: stream ? 'Keep going for a while.' : 'Say pong.' }]
      })),
      signal
    })
    const textOf = (request, stream, text) => {
      if (!stream) {
        const payload = JSON.parse(text)
        return request.route === '/v1/messages'
          ? payload.content.filter(block => block.type === 'text').map(block => block.text).join('')
          : payload.choices[0].message.content
      }
      const data = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'))
      if (request.route === '/v1/messages') {
        return data.filter(Boolean).map(JSON.parse).filter(event => event.delta?.type === 'text_delta')
          .map(event => event.delta.text).join('')
      }
      return data.filter(dataLine => dataLine && dataLine !== '[DONE]').map(JSON.parse)
        .map(event => event.choices?.[0]?.delta?.content || '').join('')
    }

    // A client that stays: every path answers as before, through the relay.
    for (const request of requests) {
      for (const stream of [false, true]) {
        plan = { name: 'short', wrapped: request.tools }
        const before = relays.length
        const response = await send(request, stream, AbortSignal.timeout(30000))
        const text = await response.text()
        assert.equal(response.status, 200, `${label(request, stream)}: ${text}`)
        assert.equal(textOf(request, stream, text), 'pong', label(request, stream))
        const relay = relays[before]
        assert.ok(relay, `${label(request, stream)}: the answer never came through the relay`)
        assert.equal(relay.endedAt !== null, true, `${label(request, stream)}: the relay ended by itself`)
        console.log(`PASS: ${label(request, stream)} — a client that stays gets its answer`)
      }
    }

    // Images and video (Qwen2API-3ue.10): the routes of the two paths, each answered by
    // the plan of its kind. Nothing reaches a media client before its answer is whole —
    // a picture's or a video's is written at once, at the end.
    const MEDIA = [
      {
        kind: 'an image', route: '/v1/images/generations',
        body: () => ({ model: MODEL, prompt: 'a cat' }),
        carries: text => JSON.parse(text).data[0].url === IMAGE_URL
      },
      {
        kind: 'an image', route: '/v1/chat/completions',
        body: () => ({ model: IMAGE_MODEL, messages: [{ role: 'user', content: 'a cat' }] }),
        carries: text => JSON.parse(text).choices[0].message.content === `![image](${IMAGE_URL})`
      },
      {
        kind: 'an image', route: '/v1/chat/completions', streamed: true,
        body: () => ({ model: IMAGE_MODEL, stream: true, messages: [{ role: 'user', content: 'a cat' }] }),
        carries: text => text.includes(IMAGE_URL) && text.includes('[DONE]')
      },
      {
        kind: 'a video', route: '/v1/videos',
        body: () => ({ model: MODEL, prompt: 'a cat' }),
        carries: text => JSON.parse(text).data[0].url === VIDEO_URL
      },
      {
        kind: 'a video', route: '/v1/chat/completions',
        body: () => ({ model: VIDEO_MODEL, messages: [{ role: 'user', content: 'a cat' }] }),
        carries: text => JSON.parse(text).choices[0].message.content.includes(VIDEO_URL)
      },
      {
        kind: 'a video', route: '/v1/chat/completions', streamed: true,
        body: () => ({ model: VIDEO_MODEL, stream: true, messages: [{ role: 'user', content: 'a cat' }] }),
        carries: text => text.includes(VIDEO_URL) && text.includes('[DONE]')
      }
    ]
    const mediaLabel = media => `${media.route}, ${media.kind}${media.streamed ? ', stream' : ''}`
    const thing = media => (media.kind === 'a video' ? 'video' : 'picture')
    // The request sent, and whether it was answered already — with what — or failed
    // to go at all: what a wait for a relay that never opens wants to know.
    const sendMedia = (media, signal) => {
      const sent = { answered: null, failed: null }
      const request = fetch(`${baseUrl}${media.route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MEDIA_KEY },
        body: JSON.stringify(media.body()),
        signal
      })
      sent.pending = request.then(response => { sent.answered = response.status; return response },
        error => { sent.failed = String(error?.cause?.message || error); return null })
      // What became of the request, for a wait that ran out of time.
      sent.said = () => `the request was ${sent.failed ? `not sent: ${sent.failed}`
        : sent.answered === null ? 'not answered yet' : `answered with ${sent.answered}`}`
      return sent
    }

    taskStatus = TASK_DONE
    for (const media of MEDIA) {
      plan = { name: media.kind === 'a video' ? 'videoTask' : 'pictureShort' }
      polls.length = 0
      const before = relays.length
      const response = await sendMedia(media, AbortSignal.timeout(30000)).pending
      const text = response === null ? '' : await response.text()
      assert.equal(response?.status, 200, `${mediaLabel(media)}: ${text}`)
      assert.ok(media.carries(text), `${mediaLabel(media)}: the answer does not carry its ${thing(media)}`)
      const relay = relays[before]
      assert.ok(relay, `${mediaLabel(media)}: the answer never came through the relay`)
      assert.equal(relay.endedAt !== null, true, `${mediaLabel(media)}: the relay ended by itself`)
      if (media.kind === 'a video') {
        assert.equal(polls.length, 1, `${mediaLabel(media)}: the task is polled once, and is done`)
      }
      console.log(`PASS: ${mediaLabel(media)} — a client that stays gets its ${thing(media)}`)
    }

    const logsBeforeLeaving = applicationLogs.length
    const linesSince = () => applicationLogs.slice(logsBeforeLeaving).split('\n').filter(Boolean)

    // A client that leaves. The stand-in has put a few frames on the relay — the
    // application has had its first — when the client breaks off; from then on the relay
    // must close at once, and not when the answer runs out.
    const leaveMidAnswer = async (request, stream, silent) => {
      plan = { name: silent ? 'silent' : 'long', wrapped: request.tools }
      const before = relays.length
      const controller = new AbortController()
      const pending = send(request, stream, controller.signal).catch(() => null)
      await until(() => relays.length > before, 10000, `the relay of ${label(request, stream)}`)
      const relay = relays[before]
      if (stream) {
        const response = await pending
        const reader = response.body.getReader()
        await reader.read()
        reader.releaseLock?.()
      } else {
        // Nothing reaches a non-streaming client before the end: leave it a moment after
        // the answer began (a silent one begins with a single frame).
        await until(() => relay.sent >= (silent ? 1 : 2), 5000, `the answer of ${label(request, stream)}`)
        await delay(100)
      }
      const leftAt = Date.now()
      controller.abort()
      await until(() => relay.closedAt !== null, CLOSE_WITHIN_MS * 4,
        `the relay of ${label(request, stream)} to close`,
        () => `the stand-in saw ${relay.seen.join('; ') || 'nothing'}; ${relay.sent} frames sent; ` +
          `socket.destroyed=${relay.socketState?.()}`)
      await pending
      const lag = relay.closedAt - leftAt
      assert.equal(relay.endedAt, null, `${label(request, stream)}: the answer ran to its end — nobody closed it`)
      assert.ok(lag < CLOSE_WITHIN_MS, `${label(request, stream)}: the relay closed ${lag} ms after the client left`)
      assert.ok(relay.sent < 20, `${label(request, stream)}: ${relay.sent} frames were generated for nobody`)
      console.log(`PASS: ${label(request, stream)}, ${relay.plan} — the client left, the relay closed ${lag} ms later ` +
        `(${relay.sent} frames generated)`)
    }
    for (const request of requests) {
      for (const stream of [false, true]) {
        await leaveMidAnswer(request, stream, false)
        await leaveMidAnswer(request, stream, true)
      }
    }

    // An image being generated for a client that leaves: the stand-in has put a few
    // frames on the relay — the picture is still being drawn — when the client breaks
    // off; from then on the relay must close at once, and not when the generation runs out.
    const leaveWhileDrawing = async (media) => {
      plan = { name: 'picture' }
      const before = relays.length
      const controller = new AbortController()
      const { pending, said } = sendMedia(media, controller.signal)
      await until(() => relays.length > before, 10000, `the relay of ${mediaLabel(media)}`, said)
      const relay = relays[before]
      await until(() => relay.sent >= 2, 5000, `the answer of ${mediaLabel(media)}`)
      await delay(100)
      const leftAt = Date.now()
      controller.abort()
      await until(() => relay.closedAt !== null, CLOSE_WITHIN_MS * 4,
        `the relay of ${mediaLabel(media)} to close`,
        () => `the stand-in saw ${relay.seen.join('; ') || 'nothing'}; ${relay.sent} frames sent; ` +
          `socket.destroyed=${relay.socketState?.()}`)
      await pending
      const lag = relay.closedAt - leftAt
      assert.equal(relay.endedAt, null, `${mediaLabel(media)}: the generation ran to its end — nobody closed it`)
      assert.ok(lag < CLOSE_WITHIN_MS, `${mediaLabel(media)}: the relay closed ${lag} ms after the client left`)
      assert.ok(relay.sent < 20, `${mediaLabel(media)}: ${relay.sent} frames were generated for nobody`)
      console.log(`PASS: ${mediaLabel(media)} — the client left, the relay closed ${lag} ms later ` +
        `(${relay.sent} frames generated)`)
    }
    for (const media of MEDIA.filter(item => item.kind === 'an image')) await leaveWhileDrawing(media)

    // A video task polled for a client that leaves: the task is in and its first poll
    // said "not done" — the request is asleep in the task's twenty seconds — when the
    // client breaks off. A request still asleep polls again on the far side of that
    // pause; one that ended with its client does not. Waited out once, in full: all
    // three routes go through the same pause.
    const leaveWhilePolling = async (media, waitForTheNextPoll) => {
      plan = { name: 'videoTask' }
      taskStatus = TASK_RUNNING
      polls.length = 0
      const controller = new AbortController()
      const { pending, said } = sendMedia(media, controller.signal)
      await until(() => polls.length === 1, 10000, `the first poll of ${mediaLabel(media)}`, said)
      assert.equal(relays.at(-1).endedAt !== null, true, `${mediaLabel(media)}: the task's answer was read whole`)
      await delay(100)
      controller.abort()
      await pending
      // The application asks its socket every quarter of a second (CLOSE_WITHIN_MS).
      const wait = waitForTheNextPoll ? POLL_PAUSE_MS + 3000 : 1500
      await delay(wait)
      assert.equal(polls.length, 1, `${mediaLabel(media)}: the task was polled again for a client that is gone`)
      console.log(`PASS: ${mediaLabel(media)} — the client left, the task is polled no more ` +
        `(waited ${Math.round(wait / 1000)} s)`)
    }
    for (const [index, media] of MEDIA.filter(item => item.kind === 'a video').entries()) {
      await leaveWhilePolling(media, index === 0)
    }

    // What the leaving must not cost: not one error line, and not one interruption of the
    // egress counted.
    const lines = linesSince()
    const logged = lines.filter(line => /\[(ERROR|WARN)\]/.test(line))
    assert.deepEqual(logged.filter(line => /\[ERROR\]/.test(line) || /mid_stream_/.test(line)), [],
      'a client leaving is not a failure')
    console.log('PASS: no error line and no mid_stream_* line for a client that left')
    // Shown, not asserted: what the application warned about while clients left.
    for (const line of logged) console.log(`  warned: ${line.replace(/^\S+ \S+ /, '').slice(0, 150)}`)

    application.kill('SIGTERM')
    const shutdownTimer = setTimeout(() => application.kill('SIGKILL'), 10000)
    const exitCode = await applicationClosed
    clearTimeout(shutdownTimer)
    assert.equal(exitCode, 0, 'SIGTERM should exit cleanly')
    console.log(`PASS: a client that goes away takes its upstream with it, through the application on Bun`)
  } catch (error) {
    if (applicationLogs) console.error(applicationLogs)
    // Whether there was an application to answer at all.
    console.error(`application: exitCode=${application?.exitCode} signalCode=${application?.signalCode}`)
    throw error
  } finally {
    if (application && application.exitCode === null && application.signalCode === null) application.kill('SIGKILL')
    if (applicationClosed) await applicationClosed
    await closeListener(standIn)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
