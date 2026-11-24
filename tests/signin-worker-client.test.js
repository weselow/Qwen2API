const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const axios = require('axios')

// A loopback fake signin-worker exercises the client's HTTP contract: request
// shape, auth header, response parsing and error-code mapping. The client
// resolves config at require time, so each scenario re-requires with a
// controlled SIGNIN_WORKER_URL.
function freshClient(env) {
  const saved = {}
  const keys = ['SIGNIN_WORKER_URL', 'SIGNIN_WORKER_TOKEN', 'SIGNIN_WORKER_TIMEOUT_MS', 'V2_SESSION_MODE',
    'QWEN_CHAT_PROXY_URL', 'PROXY_URL', 'API_KEY']
  for (const key of keys) {
    saved[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  for (const mod of ['../src/config', '../src/utils/proxy-helper', '../src/utils/v2-session-store', '../src/utils/signin-worker-client']) {
    delete require.cache[require.resolve(mod)]
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    for (const mod of ['../src/config', '../src/utils/proxy-helper', '../src/utils/v2-session-store', '../src/utils/signin-worker-client']) {
      delete require.cache[require.resolve(mod)]
    }
  }
}

const cookies = [
  { name: 'cna', value: 'chat', domain: 'chat.qwen.ai', path: '/', secure: true, httpOnly: false, expires: -1 },
  { name: 'authsess', value: 'auth', domain: 'auth.qwen.ai', path: '/', secure: true, httpOnly: false, expires: -1 }
]

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

test('signin worker client maps worker responses onto sessions and sign-in errors', async t => {
  const requests = []
  let behavior = 'ok'
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      if (req.url === '/session' && behavior === 'ok') {
        return reply(res, 200, { token: 'worker-token', expiresAt: 1893456000, cookies })
      }
      if (req.url === '/session' && behavior === 'bad_credentials') {
        return reply(res, 401, { code: 'invalid_credentials', message: 'Qwen rejected the credentials.' })
      }
      if (req.url === '/session' && behavior === 'paced') {
        return reply(res, 429, { code: 'signin_paced', message: 'Too many sign-ins are waiting; retry later.', retryAfterMs: 45000 })
      }
      if (req.url === '/renew' && behavior === 'no_profile') {
        return reply(res, 404, { code: 'no_profile', message: 'No persisted profile for this account.' })
      }
      if (req.url === '/renew' && behavior === 'ok') {
        return reply(res, 200, { token: 'renewed-token', expiresAt: 1893456000, cookies })
      }
      if (behavior === 'malformed') {
        return reply(res, 200, { token: '', cookies: [] })
      }
      reply(res, 500, { code: 'browser_error', message: 'boom' })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => new Promise(resolve => server.close(resolve)))

  const restore = freshClient({
    API_KEY: 'offline',
    V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai',
    SIGNIN_WORKER_URL: `http://127.0.0.1:${port}`,
    SIGNIN_WORKER_TOKEN: 'shared-secret'
  })
  let client
  try {
    client = require('../src/utils/signin-worker-client')

    const session = await client.acquireSession('a@example.invalid', 'pw123', { proxy: 'http://p:8080' })
    assert.equal(session.token, 'worker-token')
    assert.equal(session.expiresAt, 1893456000)
    assert.deepEqual(requests[0].body, { email: 'a@example.invalid', password: 'pw123', proxy: 'http://p:8080' })
    assert.equal(requests[0].auth, 'Bearer shared-secret')
    const jarCookies = session.jar.getCookiesSync('https://chat.qwen.ai/')
    assert.deepEqual(jarCookies.map(cookie => cookie.key).sort(), ['cna'])
    assert.equal(jarCookies[0].value, 'chat')
    assert.equal(session.jar.getCookiesSync('https://auth.qwen.ai/').length, 1)

    const renewed = await client.renewSession('a@example.invalid', null)
    assert.equal(renewed.token, 'renewed-token')
    assert.equal(requests[1].url, '/renew')
    assert.deepEqual(requests[1].body, { email: 'a@example.invalid', proxy: null })

    behavior = 'bad_credentials'
    await assert.rejects(client.acquireSession('a@example.invalid', 'pw123', null),
      { code: 'signin_rejected', status: 401 })

    behavior = 'no_profile'
    await assert.rejects(client.renewSession('a@example.invalid', null), error => {
      assert.equal(error.code, 'signin_session_lost')
      assert.equal(error.sessionLost, true)
      return true
    })

    behavior = 'malformed'
    await assert.rejects(client.acquireSession('a@example.invalid', 'pw123', null),
      { code: 'signin_upstream_error' })

    // force is what asks the worker for a real sign-in; nothing else changes the body.
    behavior = 'ok'
    await client.acquireSession('a@example.invalid', 'pw123', null, { force: true })
    assert.deepEqual(requests.at(-1).body, { email: 'a@example.invalid', password: 'pw123', proxy: null, force: true })

    // The worker paces full logins (Qwen2API-43a). A refused slot is a
    // retryable "busy": not a dead worker and not a lost profile, so no
    // caller falls back to another full sign-in over it.
    behavior = 'paced'
    await assert.rejects(client.acquireSession('a@example.invalid', 'pw123', null), error => {
      assert.equal(error.code, 'signin_busy')
      assert.equal(error.status, 429)
      assert.equal(error.upstreamStatus, 429)
      assert.equal(error.sessionLost, false)
      assert.equal(error.retryAfterMs, 45000)
      return true
    })
  } finally {
    restore()
  }

  // Worker unreachable: connection refused maps onto the transport error.
  const second = freshClient({
    API_KEY: 'offline',
    V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai',
    SIGNIN_WORKER_URL: 'http://127.0.0.1:1'
  })
  try {
    const offline = require('../src/utils/signin-worker-client')
    await assert.rejects(offline.acquireSession('a@example.invalid', 'pw123', null),
      { code: 'signin_transport_error' })
  } finally {
    second()
  }
})

test('a worker call waits in the worker’s login line: the budget is SIGNIN_WORKER_TIMEOUT_MS', async t => {
  // 240 s covers the worker's longest sign-in wait (120 s) plus the browser
  // flow (120 s); below that the app gives up on a sign-in the worker still runs.
  const defaults = freshClient({ API_KEY: 'offline' })
  try {
    assert.equal(require('../src/config').signinWorkerTimeoutMs, 240000)
  } finally {
    defaults()
  }

  const restore = freshClient({ API_KEY: 'offline', SIGNIN_WORKER_TIMEOUT_MS: '9000' })
  try {
    const post = t.mock.method(axios, 'post',
      async () => ({ status: 200, data: { token: 'worker-token', expiresAt: 1893456000, cookies } }))
    const client = require('../src/utils/signin-worker-client')
    await client.acquireSession('a@example.invalid', 'pw123', null)
    await client.renewSession('a@example.invalid', null)
    assert.deepEqual(post.mock.calls.map(call => call.arguments[2].timeout), [9000, 9000])
  } finally {
    restore()
  }
})

test('signin worker client carries egress calls and the forced renewal (Qwen2API-3ue.2)', async t => {
  const requests = []
  let scripted = { status: 200, body: {} }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      reply(res, scripted.status, scripted.body)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const restore = freshClient({
    API_KEY: 'offline',
    V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai',
    PROXY_URL: 'http://global:8080',
    SIGNIN_WORKER_URL: `http://127.0.0.1:${server.address().port}`,
    SIGNIN_WORKER_TOKEN: 'shared-secret'
  })
  const realPost = axios.post
  let config
  axios.post = async (url, payload, requestConfig) => {
    config = requestConfig
    return realPost(url, payload, requestConfig)
  }
  t.after(() => { axios.post = realPost })
  try {
    const client = require('../src/utils/signin-worker-client')
    const email = 'a@example.invalid'

    // The call as the page runs it; the account's proxy opens the page.
    scripted = { status: 200, body: {
      status: 401, headers: { 'content-type': 'application/json' }, body: '{"success":false}',
      url: 'https://chat.qwen.ai/api/v2/chats/new', redirected: false, cookies
    } }
    const result = await client.egress(email, { proxy: 'http://p:8080' }, {
      url: '/api/v2/chats/new', headers: { 'content-type': 'application/json' }, body: '{"chatId":""}', timeoutMs: 5000
    })
    assert.deepEqual(result, scripted.body, "qwen.ai's status and body come back as they are")
    assert.deepEqual(requests.at(-1), {
      url: '/egress', auth: 'Bearer shared-secret', body: {
        email, url: '/api/v2/chats/new', method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{"chatId":""}', timeoutMs: 5000, proxy: 'http://p:8080'
      }
    })
    // The HTTP budget is the call, the worker's own budget (which covers a
    // sign-in the account's call may wait behind) and the page's open.
    const { signinWorkerTimeoutMs } = require('../src/config')
    assert.equal(config.timeout, 5000 + signinWorkerTimeoutMs + client.EGRESS_OPEN_MARGIN_MS)
    assert.ok(signinWorkerTimeoutMs >= 120000 + 120000, 'the worker budget covers its longest sign-in wait plus the sign-in itself')

    // No account proxy: the global one applies, as for every worker call.
    await client.egress(email, null, { url: '/api/v2/models', method: 'GET', timeoutMs: 1000 })
    assert.equal(requests.at(-1).body.proxy, 'http://global:8080')
    assert.equal(requests.at(-1).body.method, 'GET')

    // A forced renewal asks the worker for a live reload; the plain one is unchanged.
    scripted = { status: 200, body: { token: 'renewed-token', expiresAt: 1893456000, cookies } }
    const renewed = await client.renewSession(email, null, { force: true })
    assert.equal(renewed.token, 'renewed-token')
    assert.deepEqual(requests.at(-1), { url: '/renew', auth: 'Bearer shared-secret', body: { email, proxy: 'http://global:8080', force: true } })
    await client.renewSession(email, null)
    assert.deepEqual(requests.at(-1).body, { email, proxy: 'http://global:8080' })

    // Worker-side failures keep the worker's own code for the log.
    for (const [status, code, expected] of [
      [504, 'egress_timeout', { code: 'signin_upstream_error', status: 502, workerCode: 'egress_timeout', sessionLost: false }],
      [502, 'page_closed', { code: 'signin_upstream_error', status: 502, workerCode: 'page_closed', sessionLost: false }],
      [422, 'session_expired', { code: 'signin_session_lost', status: 422, workerCode: 'session_expired', sessionLost: true }]
    ]) {
      scripted = { status, body: { code, message: 'scripted' } }
      await assert.rejects(client.egress(email, null, { url: '/api/v2/chats/new' }), error => {
        for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, `${code}: ${key}`)
        return true
      })
    }

    // An answer that is not an egress result is the worker's fault, not an empty upstream body.
    for (const body of [{ status: 200, body: {} }, { status: '200', body: '', cookies: [] }, { status: 200, body: '' }, { status: 200, body: '', cookies: 'jar' }]) {
      scripted = { status: 200, body }
      await assert.rejects(client.egress(email, null, { url: '/api/v2/chats/new' }), { code: 'signin_upstream_error', status: 502 })
    }

    // A worker that is up but has not answered yet is not "unreachable": the
    // code is the same, the log line is not.
    axios.post = async () => { throw Object.assign(new Error('timeout of 1ms exceeded'), { code: 'ECONNABORTED' }) }
    await assert.rejects(client.egress(email, null, { url: '/api/v2/chats/new' }),
      { code: 'signin_transport_error', status: 502, message: 'Signin worker did not answer in time.' })
    axios.post = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
    await assert.rejects(client.egress(email, null, { url: '/api/v2/chats/new' }),
      { code: 'signin_transport_error', status: 502, message: 'Signin worker unreachable.' })
  } finally {
    restore()
  }
})

test('signin worker client carries a streaming egress call, and its failures (Qwen2API-3ue.3)', { timeout: 10000 }, async t => {
  const CHAT = 'https://chat.qwen.ai'
  const requests = []
  let behavior = 'relay'
  let hungUp
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      // The worker's side of the app hanging up, with whether the relay had ended.
      res.on('close', () => hungUp?.(res.writableEnded))
      if (behavior === 'refused') return reply(res, 504, { code: 'egress_timeout', message: 'scripted' })
      if (behavior === 'lost') return reply(res, 404, { code: 'no_profile', message: 'scripted' })
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"head","status":200,"url":"' + CHAT + '/api/v2/chat/completions","redirected":false,' +
        '"headers":{"content-type":"text/event-stream"},"cookies":[]}\n')
      if (behavior === 'hold') return // the answer is still coming
      if (behavior === 'garbage') return res.end('not an event\n')
      res.write('{"type":"chunk","data":"' + Buffer.from('data: x\n\n').toString('base64') + '"}\n')
      return res.end('{"type":"end","cookies":[{"name":"cna","value":"live","domain":"chat.qwen.ai","path":"/"}]}\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.() }))
  // Resolves once the worker saw its app close the connection.
  const closed = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the app never closed the relay')), 3000)
    hungUp = ended => { clearTimeout(timer); resolve(ended) }
  })

  const restore = freshClient({
    API_KEY: 'offline',
    V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: CHAT,
    SIGNIN_WORKER_URL: `http://127.0.0.1:${server.address().port}`,
    SIGNIN_WORKER_TOKEN: 'shared-secret'
  })
  const realPost = axios.post
  let httpConfig
  axios.post = async (url, payload, requestConfig) => {
    httpConfig = requestConfig
    return realPost(url, payload, requestConfig)
  }
  t.after(() => { axios.post = realPost })
  try {
    const client = require('../src/utils/signin-worker-client')
    const email = 'a@example.invalid'
    const request = { url: '/api/v2/chat/completions', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 5000 }

    // The call as the page runs it, asked of the worker as a stream.
    behavior = 'relay'
    const relay = await client.egressStream(email, { proxy: 'http://p:8080' }, request)
    assert.deepEqual(requests.at(-1), {
      url: '/egress', auth: 'Bearer shared-secret', body: {
        email, url: '/api/v2/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{}', timeoutMs: 5000, proxy: 'http://p:8080', stream: true
      }
    })
    // Streamed, and on no timer of axios's: the budget is the module's own,
    // and a stream outlives it.
    assert.deepEqual(
      { responseType: httpConfig.responseType, timeout: httpConfig.timeout, maxRedirects: httpConfig.maxRedirects },
      { responseType: 'stream', timeout: 0, maxRedirects: 0 })
    const events = []
    for await (const event of relay.frames) events.push(event)
    assert.deepEqual(events, [
      { type: 'head', status: 200, url: `${CHAT}/api/v2/chat/completions`, redirected: false, headers: { 'content-type': 'text/event-stream' }, cookies: [] },
      { type: 'chunk', data: Buffer.from('data: x\n\n').toString('base64') },
      { type: 'end', cookies: [{ name: 'cna', value: 'live', domain: 'chat.qwen.ai', path: '/' }] }
    ])

    // A refusal to a streamed call is the same SigninError as to any other:
    // the worker's JSON arrives as a stream too, and is read.
    for (const [mode, expected] of [
      ['refused', { code: 'signin_upstream_error', status: 502, workerCode: 'egress_timeout', sessionLost: false }],
      ['lost', { code: 'signin_session_lost', status: 404, workerCode: 'no_profile', sessionLost: true }]
    ]) {
      behavior = mode
      await assert.rejects(client.egressStream(email, null, request), error => {
        for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, `${mode}: ${key}`)
        return true
      })
    }

    // A line that is not an event is the worker's fault.
    behavior = 'garbage'
    await assert.rejects(async () => {
      for await (const event of (await client.egressStream(email, null, request)).frames) void event
    }, { code: 'signin_upstream_error', status: 502, message: 'Signin worker returned a malformed egress stream.' })

    // The app cancelling is it closing the connection: a relay it is done
    // reading ends on the worker's side, answer or no answer.
    behavior = 'hold'
    const waiting = closed()
    const unread = await client.egressStream(email, null, request)
    unread.close()
    assert.equal(await waiting, false)
    const reading = closed()
    for await (const event of (await client.egressStream(email, null, request)).frames) {
      if (event.type === 'head') break // what the consumer's "stop" amounts to
    }
    assert.equal(await reading, false)
  } finally {
    restore()
  }
})
