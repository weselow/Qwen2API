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
  for (const mod of ['../src/config', '../src/utils/v2-session-store', '../src/utils/signin-worker-client']) {
    delete require.cache[require.resolve(mod)]
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    for (const mod of ['../src/config', '../src/utils/v2-session-store', '../src/utils/signin-worker-client']) {
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
