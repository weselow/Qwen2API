const assert = require('node:assert/strict')
const axios = require('axios')
const { CookieJar } = require('tough-cookie')

const formOrigin = 'https://form.session.test'
const authOrigin = 'https://auth.session.test'
const formUrl = formOrigin + '/auth'
const signinUrl = authOrigin + '/api/v2/auths/signin'

process.env.QWEN_CHAT_PROXY_URL = formOrigin
process.env.QWEN_LAB_V2_AUTH_ORIGIN = authOrigin
process.env.PROXY_URL = ''
process.env.API_KEY = 'fixture'
process.env.ENABLE_FILE_LOG = 'false'
const TokenManager = require('../../src/utils/token-manager')
const sessions = require('../../src/utils/v2-lab-sessions').sessions

// The fixture has just two users and can issue only these inert test values.
const users = ['alice', 'bob']
const emailFor = user => user + '@example.invalid'
const cookieLines = user => [
  `fixture_locale=${user}; Domain=session.test; Path=/api/v2/auths; Secure; HttpOnly`,
  `fixture_page=${user}; Path=/; Secure`,
  `fixture_help=${user}; Domain=session.test; Path=/help; Secure`
]

function fixtureTransport(user, records) {
  assert.ok(users.includes(user))
  return async config => {
    const cookie = config.headers.get('cookie') || ''
    const record = { method: config.method, url: config.url, cookie }
    records.push(record)
    if (config.method === 'get' && config.url === formUrl) {
      return { status: 200, headers: { 'set-cookie': cookieLines(user) }, data: 'fixture form', config }
    }
    assert.equal(config.method, 'post')
    assert.equal(config.url, signinUrl)
    assert.equal(JSON.parse(config.data).email, emailFor(user))
    if (cookie !== 'fixture_locale=' + user) {
      const response = { status: 409, data: { error: 'fixture form state mismatch' }, headers: {}, config }
      throw new axios.AxiosError('fixture rejected', 'ERR_BAD_REQUEST', config, null, response)
    }
    const payload = Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
    const token = 'eyJhbGciOiJub25lIn0.' + payload + '.fixture'
    return { status: 200, headers: { 'content-type': 'application/json' }, data: { token }, config }
  }
}

// Test-only form flow. Its Axios instance has no network transport.
class FixtureFormLogin extends TokenManager {
  constructor(user, records) {
    const http = axios.create({ adapter: fixtureTransport(user, records) })
    super(http)
    this.user = user
    this.jar = new CookieJar()
    http.interceptors.request.use(config => {
      if (config.url === signinUrl) config.headers.set('cookie', this.jar.getCookieStringSync(signinUrl))
      return config
    })
  }

  async submitForm() {
    const page = await this.httpClient.get(formUrl)
    const lines = page.headers['set-cookie']
    assert.deepEqual(lines, cookieLines(this.user))
    for (const line of lines) this.jar.setCookieSync(line, formUrl)
    return this.login(emailFor(this.user), 'fixture', undefined, { throwOnFailure: true })
  }
}

async function exercise() {
  const traces = users.map(() => [])
  for (const [index, user] of users.entries()) {
    const direct = new TokenManager(axios.create({ adapter: fixtureTransport(user, traces[index]) }))
    assert.equal(await direct.login(emailFor(user), 'fixture'), null)
    assert.deepEqual(traces[index], [{ method: 'post', url: signinUrl, cookie: '' }])
    assert.equal(sessions.has(emailFor(user)), false)
    traces[index].length = 0
  }

  const clients = users.map((user, index) => new FixtureFormLogin(user, traces[index]))
  const tokens = await Promise.all(clients.map(client => client.submitForm()))
  for (const [index, user] of users.entries()) {
    assert.equal(clients[index].validateToken(tokens[index]).sub, user)
    assert.deepEqual(traces[index], [
      { method: 'get', url: formUrl, cookie: '' },
      { method: 'post', url: signinUrl, cookie: 'fixture_locale=' + user }
    ])
    assert.equal(sessions.get(emailFor(user)).token, tokens[index])
  }

  // Negative control: a well-scoped cookie from the wrong fixture account is rejected.
  const wrongUser = axios.create({ adapter: fixtureTransport('bob', []) })
  wrongUser.defaults.headers.common.Cookie = clients[0].jar.getCookieStringSync(signinUrl)
  assert.equal(await new TokenManager(wrongUser).login(emailFor('bob'), 'fixture'), null)
  assert.equal(sessions.get(emailFor('bob')).token, tokens[1])
}

exercise().catch(error => { console.error(error); process.exitCode = 1 })
