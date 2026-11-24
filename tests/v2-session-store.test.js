const test = require('node:test')
const assert = require('node:assert/strict')

// The store and config resolve V2_SESSION_MODE at require time; each scenario
// below re-requires them with a controlled env (test files run in their own
// process, so the purges never leak into other suites).
function fresh(env) {
  const saved = {}
  const keys = ['V2_SESSION_MODE', 'QWEN_LAB_V2_AUTH_ORIGIN', 'QWEN_CHAT_PROXY_URL', 'PROXY_URL', 'API_KEY']
  for (const key of keys) {
    saved[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  for (const mod of ['../src/config', '../src/utils/v2-session-store', '../src/utils/v2-lab-sessions']) {
    delete require.cache[require.resolve(mod)]
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    for (const mod of ['../src/config', '../src/utils/v2-session-store', '../src/utils/v2-lab-sessions']) {
      delete require.cache[require.resolve(mod)]
    }
  }
}

function jwtFixture() {
  const payload = { sub: 'a@example.invalid', exp: Math.floor(Date.now() / 1000) + 3600 }
  return 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture'
}

const browserCookies = [
  { name: 'cna', value: 'chat', domain: 'chat.qwen.ai', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 },
  { name: 'acw_tc', value: 'hidden', domain: 'chat.qwen.ai', path: '/', secure: true, httpOnly: true, expires: -1 },
  { name: 'ssx', value: 'wide', domain: '.qwen.ai', path: '/', secure: true, httpOnly: false, expires: -1 },
  { name: 'authsess', value: 'authonly', domain: 'auth.qwen.ai', path: '/', secure: true, httpOnly: false, expires: -1 }
]

test('v2 session store stays inert in the default off mode', () => {
  const restore = fresh({ API_KEY: 'offline' })
  try {
    const store = require('../src/utils/v2-session-store')
    assert.equal(store.mode, 'off')
    assert.equal(store.active, false)
    assert.equal(store.browser, false)
    const requestConfig = { headers: { cookie: 'legacy=keep' } }
    store.prepareChat(requestConfig, 'https://chat.qwen.ai/api/v2/chat/completions', { email: 'a@example.invalid' }, 't')
    assert.deepEqual(requestConfig, { headers: { cookie: 'legacy=keep' } })
  } finally {
    restore()
  }
})

test('QWEN_LAB_V2_AUTH_ORIGIN alone still selects lab mode (back-compat)', () => {
  const restore = fresh({
    API_KEY: 'offline',
    QWEN_LAB_V2_AUTH_ORIGIN: 'https://auth.stand.test:8443',
    QWEN_CHAT_PROXY_URL: 'https://chat.stand.test:8443'
  })
  try {
    const store = require('../src/utils/v2-session-store')
    const lab = require('../src/utils/v2-lab-sessions')
    assert.equal(store.mode, 'lab')
    assert.equal(lab.authOrigin, 'https://auth.stand.test:8443')
    assert.equal(store.chatOrigin, 'https://chat.stand.test:8443')
  } finally {
    restore()
  }
})

test('browser mode scopes worker cookies by domain/path and merges them over app cookies', () => {
  const restore = fresh({ API_KEY: 'offline', V2_SESSION_MODE: 'browser', QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai' })
  try {
    const store = require('../src/utils/v2-session-store')
    assert.equal(store.mode, 'browser')
    assert.equal(store.browser, true)

    const jar = store.jarFromCookies(browserCookies)
    const token = jwtFixture()
    const account = { email: 'a@example.invalid' }
    store.setSession(account.email, { token, expiresAt: 1, jar })
    assert.equal(store.sessionFor(account.email, 'other-token'), null)
    assert.ok(store.sessionFor(account.email, token))

    const requestConfig = { headers: { cookie: 'legacy=keep; cna=stale' } }
    store.prepareChat(requestConfig, 'https://chat.qwen.ai/api/v2/chats/new', account, token)
    const pairs = Object.fromEntries(requestConfig.headers.cookie.split(/;\s*/).map(pair => {
      const i = pair.indexOf('=')
      return [pair.slice(0, i), pair.slice(i + 1)]
    }))
    assert.equal(pairs.cna, 'chat')
    assert.equal(pairs.acw_tc, 'hidden')
    assert.equal(pairs.ssx, 'wide')
    assert.equal(pairs.legacy, 'keep')
    assert.equal(pairs.authsess, undefined)
    // Browser mode must not pin proxy:false: the account proxy keeps routing.
    assert.equal(requestConfig.proxy, undefined)

    assert.throws(() => store.prepareChat({}, 'https://evil.example/x', account, token), /Unexpected v2 chat origin/)
    const bare = { headers: {} }
    assert.throws(() => store.prepareChat(bare, 'https://chat.qwen.ai/api/v2/chat/completions', account, 'mismatch'),
      { code: 'v2_session_required', status: 409 })

    store.deleteSession(account.email)
    assert.equal(store.sessionFor(account.email, token), null)
    store.setSession(account.email, { token, expiresAt: 1, jar })
    store.clearSessions()
    assert.equal(store.sessions.size, 0)
  } finally {
    restore()
  }
})

test('the store folds the browser jar and Set-Cookie into a session, server-set first (Qwen2API-3ue.2)', () => {
  const restore = fresh({ API_KEY: 'offline', V2_SESSION_MODE: 'browser', QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai' })
  try {
    const store = require('../src/utils/v2-session-store')
    const token = jwtFixture()
    const email = 'a@example.invalid'
    const chat = 'https://chat.qwen.ai/api/v2/chats/new'
    const held = url => store.sessions.get(email).jar.getCookiesSync(url).map(cookie => cookie.cookieString()).sort()
    const names = () => held(chat)
    const auth = 'https://auth.qwen.ai/'
    const browserJar = [
      { name: 'cna', value: 'first', domain: 'chat.qwen.ai', path: '/', secure: true },
      { name: 'ssx', value: 'wide', domain: '.qwen.ai', path: '/' },
      { name: 'authsess', value: 'auth', domain: 'auth.qwen.ai', path: '/' }
    ]

    // Nothing to fold into: no session, no change.
    assert.equal(store.mergeCookies(email, browserJar), false)
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': 'cna=1' }, chat), false)

    store.setSession(email, { token, expiresAt: 1, jar: store.jarFromCookies(browserJar) })
    assert.deepEqual(names(), ['cna=first', 'ssx=wide'])

    // The browser rotated a cookie: same name, same scope, its value wins.
    const rotated = [{ ...browserJar[0], value: 'rotated' }, { name: 'acw_tc', value: 'fresh', domain: 'chat.qwen.ai', path: '/' }]
    assert.equal(store.mergeCookies(email, rotated), true)
    assert.deepEqual(names(), ['acw_tc=fresh', 'cna=rotated', 'ssx=wide'])
    // A domain cookie (.qwen.ai) is served to the subdomain as well.
    assert.deepEqual(held(auth), ['authsess=auth', 'ssx=wide'])
    // Nothing rotated: reported as unchanged, so nothing is written through.
    assert.equal(store.mergeCookies(email, rotated), false)
    // Entries that are not cookies are skipped, as jarFromCookies skips them.
    assert.equal(store.mergeCookies(email, [null, { name: 42, value: 'x' }, { value: 'x' }, 'acw_tc=1']), false)
    assert.equal(store.mergeCookies(email, 'acw_tc=1'), false)

    // Set-Cookie from a response the app fetched itself: same precedence.
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': ['isg=1; Path=/; Secure', 'cna=from-app; Path=/'] }, chat), true)
    assert.deepEqual(names(), ['acw_tc=fresh', 'cna=from-app', 'isg=1', 'ssx=wide'])
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': ['isg=1; Path=/; Secure'] }, chat), false)
    assert.equal(store.ingestSetCookie(email, {}, chat), false)
    // What does not parse as a cookie changes nothing instead of throwing.
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': ['not a cookie'] }, chat), false)
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': ['isg=2'] }, undefined), false)

    // Off the chat origin, the cookie lands under its own host.
    assert.equal(store.ingestSetCookie(email, { 'set-cookie': ['authsess=next; Path=/'] }, 'https://auth.qwen.ai/x'), true)
    assert.deepEqual(held(auth), ['authsess=next', 'ssx=wide'])
    assert.deepEqual(names(), ['acw_tc=fresh', 'cna=from-app', 'isg=1', 'ssx=wide'])
  } finally {
    restore()
  }
})

test('a joined Set-Cookie header splits before the next cookie, never inside an Expires date', () => {
  const restore = fresh({ API_KEY: 'offline' })
  try {
    const { setCookieLines } = require('../src/utils/v2-session-store')
    assert.deepEqual(setCookieLines('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/, b=2; Path=/, c=3'), [
      'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/', 'b=2; Path=/', 'c=3'
    ])
    // What Node's parser hands over: one entry per header.
    assert.deepEqual(setCookieLines(['a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT', 'b=2']), ['a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT', 'b=2'])
    // A comma inside a value is not followed by a name and an "=": not a boundary.
    assert.deepEqual(setCookieLines('a=x,y'), ['a=x,y'])
    assert.deepEqual(setCookieLines('a=1,b=2'), ['a=1', 'b=2'])
    assert.deepEqual(setCookieLines(undefined), [])
    assert.deepEqual(setCookieLines(42), [])
    assert.deepEqual(setCookieLines(''), [])
  } finally {
    restore()
  }
})

test('V2_SESSION_MODE rejects unknown values and lab without a lab origin', () => {
  const first = fresh({ API_KEY: 'offline', V2_SESSION_MODE: 'bogus' })
  try {
    assert.throws(() => require('../src/config'), /V2_SESSION_MODE must be off, lab or browser/)
  } finally {
    first()
  }
  const second = fresh({ API_KEY: 'offline', V2_SESSION_MODE: 'lab' })
  try {
    assert.throws(() => require('../src/config'), /V2_SESSION_MODE=lab requires QWEN_LAB_V2_AUTH_ORIGIN/)
  } finally {
    second()
  }
})

test('an explicit off wins over a stray lab origin and keeps the lab flow inert', () => {
  const restore = fresh({
    API_KEY: 'offline',
    V2_SESSION_MODE: 'off',
    QWEN_LAB_V2_AUTH_ORIGIN: 'https://auth.stand.test:8443',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai'
  })
  try {
    const store = require('../src/utils/v2-session-store')
    const lab = require('../src/utils/v2-lab-sessions')
    assert.equal(store.mode, 'off')
    assert.equal(store.active, false)
    assert.equal(lab.authOrigin, null)
  } finally {
    restore()
  }
})
