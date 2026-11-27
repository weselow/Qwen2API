// The bytes of an upload go to OSS signed V4, in the region the STS answer named
// (Qwen2API-3ue.12) — verified offline, without a proxy (tests/browser-egress.test.js).
// For an account with a proxy under Bun the SDK's own HTTP is replaced by
// createOssProxyClient (src/utils/upload.js), and on that road the signature was never
// looked at: Qwen2API-fjk.
//
// Under Bun as the gate never runs: the runtime is named for the length of a test, the
// account brings a proxy, and the request the proxy client would send is caught on its
// way out — with the signature the SDK built for it. Nothing reaches a network: the proxy
// is a closed loopback port, the STS call is the page's, answered here.
//
// Same header as tests/client-gone.test.js: without API_KEY the startup cuts the process
// before the runner reports, and without DATA_SAVE_MODE=none account.js would try a real
// login on import.
process.env.QWEN_CHAT_PROXY_URL = 'http://127.0.0.1:9'
process.env.QWEN_CLI_PROXY_URL = 'http://127.0.0.1:9'
process.env.API_KEY = 'upload-proxy-v4-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const test = require('node:test')
const assert = require('node:assert/strict')
const OSS = require('ali-oss')
const axios = require('axios')

const accountManager = require('../src/utils/account')
const uploadModule = require('../src/utils/upload.js')
const browserEgress = require('../src/utils/browser-egress.js')
const { getProxyAgent, invalidateProxyAgent } = require('../src/utils/proxy-helper.js')
const config = require('../src/config')

// What the page's own STS answer looks like (front end 0.3.50): the region and the endpoint
// travel with it, and the region is what makes the upload sign V4.
// In the signature the region is named without the "oss-" the SDK's option carries.
const REGION = 'oss-ap-southeast-1'
const SIGNED_REGION = 'ap-southeast-1'
const STS_ANSWER = {
  access_key_id: 'test-access-key', access_key_secret: 'test-access-secret', security_token: 'test-security-token',
  // The endpoint as the answer names it: the region's own address, the bucket is the SDK's to add.
  bucketname: 'upload-proxy-test', region: REGION, endpoint: `https://${REGION}.aliyuncs.com`,
  file_url: 'https://example.invalid/upload.txt', file_path: 'test/upload.txt', file_id: 'upload-proxy-file'
}
const PROXIED = { email: 'proxied@example.invalid', token: 'proxied-token', proxy: 'http://127.0.0.1:9' }
const DIRECT = { email: 'direct@example.invalid', token: 'direct-token' }
const V4 = new RegExp(`^OSS4-HMAC-SHA256 Credential=test-access-key/\\d{8}/${SIGNED_REGION}/oss/aliyun_v4_request` +
  '(,AdditionalHeaders=[^,]+)?,Signature=[0-9a-f]{64}$')
const V1 = /^OSS test-access-key:[A-Za-z0-9+/=]+$/

let runtime
let pageCalls
let requests
const real = {}
const OSS_PUT = OSS.prototype.put

/** Names the runtime for one test, and puts back what the test replaced. */
async function asUnder(name, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.versions, 'bun')
  const was = process.versions.bun
  if (name === 'bun') process.versions.bun = '1.3.14'
  else delete process.versions.bun
  try {
    return await fn()
  } finally {
    if (had) process.versions.bun = was
    else delete process.versions.bun
  }
}

test.before(async () => {
  await accountManager._initPromise
  runtime = { chat: config.chatCreationTransport, completions: config.completionsTransport }
  // qwen.ai is never contacted: a direct call only goes where a test says it may.
  real.post = axios.post
  real.get = axios.get
  real.request = axios.request
  real.egressJson = browserEgress.egressJson
  axios.post = async url => { throw new Error(`offline test: no direct POST to ${url}`) }
  axios.get = async url => { throw new Error(`offline test: no direct GET to ${url}`) }
  test.after(() => {
    axios.post = real.post
    axios.get = real.get
    axios.request = real.request
    browserEgress.egressJson = real.egressJson
    OSS.prototype.put = OSS_PUT
    Object.assign(config, { chatCreationTransport: runtime.chat, completionsTransport: runtime.completions })
    for (const account of [PROXIED, DIRECT]) invalidateProxyAgent(account.proxy)
    accountManager.destroy()
  })
})

test.beforeEach(() => {
  pageCalls = []
  requests = []
  OSS.prototype.put = OSS_PUT
  axios.request = real.request
  // The token is asked for from the account's page, as on prod.
  config.chatCreationTransport = 'browser'
  config.completionsTransport = 'browser'
  browserEgress.egressJson = async context => {
    pageCalls.push(context)
    return { status: 200, statusText: 'OK', headers: {}, data: STS_ANSWER }
  }
})

/** The request the proxy client sends, caught on its way out and answered as axios would. */
const catchProxyRequest = () => {
  axios.request = async requestConfig => {
    requests.push(requestConfig)
    return {
      status: 200, statusText: 'OK', config: requestConfig, data: Buffer.from('stored'),
      headers: new axios.AxiosHeaders({ etag: '"etag"', 'x-oss-request-id': 'proxy-v4' })
    }
  }
}

test('Qwen2API-fjk: an account with a proxy, under Bun: the upload is signed V4 through createOssProxyClient, and the proxy client\'s answer is read',
  async () => asUnder('bun', async () => {
    catchProxyRequest()

    const result = await uploadModule.uploadFileToQwenOss(Buffer.from('the bytes'), 'upload.txt', PROXIED.token, PROXIED)

    // The token was asked for from the account's page, at the address the page asks.
    assert.equal(pageCalls.length, 1)
    assert.equal(pageCalls[0].account, PROXIED)
    assert.match(pageCalls[0].url, /\/api\/v2\/files\/getstsToken$/)
    // One request to OSS, by the proxy client, signed as the page signs.
    assert.equal(requests.length, 1)
    const [request] = requests
    assert.match(String(request.headers.authorization), V4)
    assert.equal(String(request.url), `https://upload-proxy-test.${REGION}.aliyuncs.com/${STS_ANSWER.file_path}`)
    assert.equal(request.method, 'PUT')
    assert.equal(Buffer.from(request.data).toString(), 'the bytes')
    assert.equal(request.httpsAgent, getProxyAgent(PROXIED), 'through the account\'s proxy')
    assert.equal(request.httpAgent, getProxyAgent(PROXIED))
    assert.equal(request.proxy, false)
    assert.equal(request.responseType, 'arraybuffer')
    // The SDK read the proxy client's answer as it reads its own HTTP's.
    assert.equal(result.status, 200)
    assert.equal(result.file_url, STS_ANSWER.file_url)
    assert.equal(result.file_id, STS_ANSWER.file_id)
  }))

test('Qwen2API-fjk: under Bun with no proxy, the SDK keeps its own HTTP — the proxy client is not made', async () => {
  const clients = []
  OSS.prototype.put = async function (objectKey) {
    clients.push(this)
    return { res: { status: 200 } }
  }

  await asUnder('bun', () => uploadModule.uploadFileToQwenOss(Buffer.from('the bytes'), 'upload.txt', DIRECT.token, DIRECT))

  assert.equal(clients.length, 1)
  assert.equal(clients[0].options.urllib, undefined, 'the SDK\'s own HTTP, as without a proxy')
  assert.deepEqual(requests, [])
})

test('Qwen2API-fjk: under Node, proxy or not, the SDK keeps its own HTTP — as before', async () => {
  const clients = []
  OSS.prototype.put = async function () {
    clients.push(this)
    return { res: { status: 200 } }
  }

  await asUnder('node', async () => {
    await uploadModule.uploadFileToQwenOss(Buffer.from('a'), 'a.txt', PROXIED.token, PROXIED)
    await uploadModule.uploadFileToQwenOss(Buffer.from('b'), 'b.txt', DIRECT.token, DIRECT)
  })

  assert.equal(clients.length, 2)
  for (const client of clients) {
    assert.equal(client.options.urllib, undefined)
    assert.equal(client.options.authorizationV4, true, 'signed V4 all the same, in the region the answer named')
    assert.equal(client.options.region, REGION)
  }
  assert.deepEqual(requests, [])
})

test('Qwen2API-fjk: with the flags off the upload is the direct path\'s, as before — the token at the old address from Node, signed V1',
  async () => {
    config.chatCreationTransport = 'direct'
    config.completionsTransport = 'direct'
    const direct = []
    axios.post = async (url, data) => {
      direct.push({ url, data })
      return { status: 200, data: STS_ANSWER }
    }
    // ali-oss's own put, as it is, with the client's HTTP replaced for the call: the request is
    // caught on its way out, with the signature the client built for it (tests/browser-egress.test.js).
    const signed = []
    OSS.prototype.put = async function (objectKey, content, options) {
      const urllib = this.urllib
      this.urllib = {
        async request(url, params) {
          signed.push({ url, authorization: params.headers.authorization })
          return { status: 200, headers: {}, data: Buffer.alloc(0), res: { status: 200, headers: {}, size: 0 } }
        }
      }
      try {
        return await OSS_PUT.call(this, objectKey, content, options)
      } finally {
        this.urllib = urllib
      }
    }

    await asUnder('node', () => uploadModule.uploadFileToQwenOss(Buffer.from('a'), 'a.txt', DIRECT.token, DIRECT))

    assert.deepEqual(pageCalls, [], 'the page is not asked')
    assert.match(direct[0].url, /\/api\/v1\/files\/getstsToken$/)
    assert.equal(signed.length, 1)
    assert.match(signed[0].authorization, V1, 'signed V1, as the direct path always signed')
    assert.deepEqual(requests, [])
  })
