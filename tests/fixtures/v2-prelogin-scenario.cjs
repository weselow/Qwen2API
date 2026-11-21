const assert = require('node:assert/strict')
const axios = require('axios')

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

function fixtureTransport(user, records, challenge = false) {
  assert.ok(users.includes(user))
  return async config => {
    const cookie = config.headers.get('cookie') || ''
    const record = { method: config.method, url: config.url, cookie }
    records.push(record)
    if (config.method === 'get' && config.url === formUrl) {
      return { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': cookieLines(user) },
        data: challenge ? '<title>Verification</title>' : '<form></form>', config }
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

async function exercise() {
  const traces = users.map(() => [])
  const clients = users.map((user, i) => new TokenManager(axios.create({ adapter: fixtureTransport(user, traces[i]) })))
  const tokens = await Promise.all(clients.map((client, i) => client.login(emailFor(users[i]), 'fixture', undefined, { throwOnFailure: true })))
  for (const [index, user] of users.entries()) {
    assert.equal(clients[index].validateToken(tokens[index]).sub, user)
    assert.deepEqual(traces[index], [
      { method: 'get', url: formUrl, cookie: '' },
      { method: 'post', url: signinUrl, cookie: 'fixture_locale=' + user }
    ])
    assert.equal(sessions.get(emailFor(user)).token, tokens[index])
  }

  const previous = sessions.get(emailFor('bob'))
  const trace = []
  const blocked = new TokenManager(axios.create({ adapter: fixtureTransport('bob', trace, true) }))
  await assert.rejects(blocked.login(emailFor('bob'), 'fixture', undefined, { throwOnFailure: true }),
    { code: 'signin_verification_required' })
  assert.deepEqual(trace, [{ method: 'get', url: formUrl, cookie: '' }])
  assert.equal(sessions.get(emailFor('bob')), previous)
}

exercise().catch(error => { console.error(error); process.exitCode = 1 })
