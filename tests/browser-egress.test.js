const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const axios = require('axios')

// Browser egress for chats/new (Qwen2API-3ue.2) is wired by env at require
// time, like every config-bound module. The worker address is a closed port
// until a test points the client at its own loopback stand-in.
Object.assign(process.env, {
    API_KEY: 'browser-egress-test', DATA_SAVE_MODE: 'none', ACCOUNTS: '', ENABLE_CLI: 'false',
    ENABLE_FILE_LOG: 'false', PROXY_URL: '', V2_SESSION_MODE: 'browser',
    QWEN_CHAT_PROXY_URL: 'https://chat.qwen.ai', SIGNIN_WORKER_URL: 'http://127.0.0.1:1',
    CHAT_CREATION_TRANSPORT: 'auto'
})
const modelsMap = require('../src/models/models-map')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const config = require('../src/config')
const store = require('../src/utils/v2-session-store')
const sessionPersistence = require('../src/utils/v2-session-persistence')
const accountManager = require('../src/utils/account')
const browserEgress = require('../src/utils/browser-egress')
const transport = require('../src/utils/impersonate-transport')
const { generateChatID, sendChatRequest } = require('../src/utils/request')
const { ChatCreationError, isWafChallengeError } = require('../src/utils/upstream-error')
const { consumeSSEStream } = require('../src/utils/sse')
const { text } = require('node:stream/consumers')
const { logger } = require('../src/utils/logger')

const EMAIL = 'egress@example.invalid'
const PASSWORD = 'egress-password'
const SECRET = 'PRIVATE_FIXTURE_MUST_NOT_ESCAPE'
const CHATS_NEW = 'https://chat.qwen.ai/api/v2/chats/new'
const COMPLETIONS = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id='
const MODEL = 'qwen3-max'
const BODY = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }

// A fixture token expires a fixed moment in the future: minting the same
// label twice gives the same string, whatever the wall clock does in between.
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 30 * 86400
const tokenWith = label => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
    sub: EMAIL, label, exp: EXPIRES_AT
})).toString('base64url') + '.fixture'
const cookie = (name, value, domain = 'chat.qwen.ai') => ({ name, value, domain, path: '/', secure: true })

// Poll until the condition holds: the app's renewals may run in the background.
async function until(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('condition not met in time')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

// A loopback stand-in for the signin worker: scripted answers per route and a
// record of everything the app sent. Nothing here knows about qwen.ai, and a
// script may return a promise to hold an answer back — or a function, which
// takes the response over (what the streaming /egress needs: relay()).
function standInWorker() {
    const calls = []
    const script = {}
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
            const route = req.url
            const call = { route, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} }
            calls.push(call)
            const answer = () => script[route.slice(1)](call.body)
            // A script that has nothing left is the test's mistake: say so
            // instead of leaving the call hanging for its whole HTTP budget.
            Promise.resolve().then(answer)
                .then(reply => reply || Promise.reject(new Error(`nothing scripted for ${route}`)))
                .then(reply => {
                    if (typeof reply === 'function') return reply(res, req)
                    res.writeHead(reply.status, { 'content-type': 'application/json' })
                    res.end(JSON.stringify(reply.body))
                }, error => {
                    res.writeHead(500)
                    res.end(JSON.stringify({ code: 'browser_error', message: String(error && error.message) }))
                })
        })
    })
    return {
        calls, script,
        routes: () => calls.map(call => call.route),
        count: route => calls.filter(call => call.route === route).length,
        sent: route => calls.filter(call => call.route === route).map(call => call.body),
        listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
            resolve(`http://127.0.0.1:${server.address().port}`)
        })),
        // A relay the app never hung up on must not hold the teardown — nor a
        // runtime whose close callback never comes.
        close: () => Promise.race([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => setTimeout(resolve, 2000))
        ]).then(() => { server.closeAllConnections?.() })
    }
}

const ok = body => ({ status: 200, body })
const refused = (status, code) => ({ status, body: { code, message: `scripted ${code}` } })
const chat = id => ({ success: true, data: { id } })
// What /egress answers: qwen.ai's status and body inside, plus the live jar.
const egress = (payload, cookies = [], status = 200) => ok({
    status, headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    url: CHATS_NEW, redirected: false, cookies
})
const challenged = () => egress('<html><meta name="aliyun_waf_aa" content="x"></html>')
const harvested = (label, cookies = [cookie('cna', `from-${label}`)]) =>
    ({ token: tokenWith(label), expiresAt: EXPIRES_AT, cookies })
const unauthorized = () => egress({ success: false, data: { code: 'unauthorized', details: SECRET } })
const refusedDirect = async () => ({ status: 200, data: { success: false, code: 'unauthorized' }, headers: {} })

// The send settings as the process was configured; a test may quicken the retry.
const SENT = { chatRetryCount: config.chatRetryCount, chatRetryBackoffMs: config.chatRetryBackoffMs }

// The worker's routes, wherever the client is pointed; anything else is qwen.ai.
const isWorkerCall = url => /^\/(egress|renew|session)$/.test(new URL(url).pathname)
let worker
let workerUrl
// Every axios call this file's app code made on its own, i.e. not through the
// worker client: these are the direct qwen.ai calls.
const direct = []
let directReply = null
const logs = []
const realPost = axios.post
const realGet = axios.get
const realLogError = logger.error
const realLogWarn = logger.warn

const current = () => store.sessions.get(EMAIL)
const jarPairs = url => Object.fromEntries(current().jar.getCookiesSync(url).map(item => [item.key, item.value]))

// An account with a session the store holds, the way a logged-in account looks.
function givenAccount(label = 'initial') {
    const account = { email: EMAIL, password: PASSWORD, token: tokenWith(label) }
    store.setSession(EMAIL, {
        token: account.token, expiresAt: EXPIRES_AT,
        jar: store.jarFromCookies([cookie('cna', 'initial')])
    })
    return account
}

// File-backed storage in a scratch dir, shared by the session store and the
// account records like it is in production.
async function withStorage(t, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-browser-egress-'))
    const persistence = sessionPersistence.persistence
    persistence.dataFilePath = path.join(dir, 'data.json')
    persistence.backupFilePath = path.join(dir, 'data.json.bak')
    persistence.v2SessionsFilePath = path.join(dir, 'v2-sessions.json')
    accountManager.dataPersistence.dataFilePath = persistence.dataFilePath
    accountManager.dataPersistence.backupFilePath = persistence.backupFilePath
    // A file nothing has written yet reads as empty.
    const read = async file => {
        try {
            return JSON.parse(await fs.promises.readFile(file, 'utf-8'))
        } catch (error) {
            if (error.code === 'ENOENT') return {}
            throw error
        }
    }
    config.dataSaveMode = 'file'
    try {
        return await fn({
            persistence,
            readAccounts: async () => (await read(persistence.dataFilePath)).accounts || [],
            readSessions: async () => (await read(persistence.v2SessionsFilePath)).sessions || {}
        })
    } finally {
        config.dataSaveMode = 'none'
        assert.equal(path.dirname(dir), os.tmpdir())
        await fs.promises.rm(dir, { recursive: true, force: true })
    }
}

test.before(async () => {
    await accountManager._initPromise
    worker = standInWorker()
    workerUrl = await worker.listen()
    config.signinWorkerUrl = workerUrl
    config.signinWorkerToken = 'shared-secret'
    // qwen.ai is never contacted: a direct call only goes where a test says it may.
    axios.post = async (url, data, requestConfig) => {
        if (isWorkerCall(url)) return realPost(url, data, requestConfig)
        direct.push({ url, data, headers: requestConfig?.headers })
        assert.ok(directReply, `no direct call to ${url} is allowed here`)
        return directReply(url, data, requestConfig)
    }
    axios.get = async url => assert.fail(`no GET to ${url} is allowed here`)
    logger.error = (...args) => logs.push(args)
    logger.warn = (...args) => logs.push(args)
})
test.after(() => {
    axios.post = realPost
    axios.get = realGet
    logger.error = realLogError
    logger.warn = realLogWarn
    return worker.close()
})

test.beforeEach(async () => {
    // A renewal the previous test left in the background must not land inside this one.
    await until(() => sessionPersistence.renewals.size === 0)
    worker.calls.length = 0
    direct.length = 0
    logs.length = 0
    directReply = null
    worker.script.egress = () => egress(chat('chat-1'))
    worker.script.renew = () => ok(harvested('renewed'))
    worker.script.session = () => ok(harvested('signed-in'))
    store.clearSessions()
    accountManager.accountTokens.length = 0
    config.chatCreationTransport = 'auto'
    config.completionsTransport = 'auto'
    Object.assign(config, SENT)
    config.signinWorkerConfigured = true
    config.sessionRecoveryMinIntervalMs = 0
    config.sessionReloginMinIntervalMs = 0
    sessionPersistence.resetRecoveryForTests()
    sessionPersistence.setRecoveryClockForTests(null)
    browserEgress.setTimingForTests()
})

/* ------------------------------------------------------------------ config -- */

test('CHAT_CREATION_TRANSPORT parses auto | browser | direct and refuses anything else', () => {
    assert.equal(config.parseChatCreationTransport(undefined), 'auto')
    assert.equal(config.parseChatCreationTransport('  '), 'auto')
    assert.equal(config.parseChatCreationTransport(' Browser '), 'browser')
    assert.equal(config.parseChatCreationTransport('direct'), 'direct')
    assert.throws(() => config.parseChatCreationTransport('worker'), /CHAT_CREATION_TRANSPORT="worker".*auto \| browser \| direct/)
})

test('auto takes the worker only for browser sessions against a configured worker', () => {
    const app = { v2SessionMode: 'browser', signinWorkerConfigured: true }
    assert.equal(browserEgress.usesWorker('auto', app), true)
    assert.equal(browserEgress.usesWorker('auto', { ...app, v2SessionMode: 'off' }), false)
    assert.equal(browserEgress.usesWorker('auto', { ...app, v2SessionMode: 'lab' }), false)
    assert.equal(browserEgress.usesWorker('auto', { ...app, signinWorkerConfigured: false }), false)
    assert.equal(browserEgress.usesWorker('browser', { v2SessionMode: 'off', signinWorkerConfigured: false }), true)
    assert.equal(browserEgress.usesWorker('direct', app), false)
})

test('a forced browser transport on another session mode is refused at startup', () => {
    const keys = ['CHAT_CREATION_TRANSPORT', 'V2_SESSION_MODE']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const fresh = () => {
        delete require.cache[require.resolve('../src/config')]
        return require('../src/config')
    }
    try {
        process.env.V2_SESSION_MODE = 'off'
        process.env.CHAT_CREATION_TRANSPORT = 'browser'
        assert.throws(fresh, /CHAT_CREATION_TRANSPORT=browser requires V2_SESSION_MODE=browser/)
        for (const transport of ['auto', 'direct']) {
            process.env.CHAT_CREATION_TRANSPORT = transport
            assert.equal(fresh().chatCreationTransport, transport)
        }
        process.env.V2_SESSION_MODE = 'browser'
        assert.equal(fresh().chatCreationTransport, 'direct')
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
        delete require.cache[require.resolve('../src/config')]
    }
})

test('a forced browser completions transport on another session mode is refused at startup too', () => {
    const keys = ['COMPLETIONS_TRANSPORT', 'V2_SESSION_MODE']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const fresh = () => {
        delete require.cache[require.resolve('../src/config')]
        return require('../src/config')
    }
    try {
        process.env.V2_SESSION_MODE = 'off'
        process.env.COMPLETIONS_TRANSPORT = 'browser'
        assert.throws(fresh, /COMPLETIONS_TRANSPORT=browser requires V2_SESSION_MODE=browser/)
        process.env.V2_SESSION_MODE = 'browser'
        assert.equal(fresh().completionsTransport, 'browser')
    } finally {
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
        delete require.cache[require.resolve('../src/config')]
    }
})

/* ------------------------------------------------------------------- wiring -- */

test('chats/new leaves through the worker and nowhere else', async () => {
    const account = givenAccount()
    assert.equal(await generateChatID(account.token, MODEL, account, 't2t'), 'chat-1')
    assert.deepEqual(direct, [], 'no axios call reaches qwen.ai')

    assert.equal(worker.calls.length, 1)
    const sent = worker.calls[0]
    assert.equal(sent.route, '/egress')
    assert.equal(sent.auth, 'Bearer shared-secret')
    assert.equal(sent.body.email, EMAIL)
    assert.equal(sent.body.url, CHATS_NEW)
    assert.equal(sent.body.method, 'POST')
    assert.equal(sent.body.proxy, null)
    assert.equal(sent.body.timeoutMs, browserEgress.CHAT_TIMEOUT_MS)
    // The profile's own cookies ride along in the browser: the app's jar is not shipped to the worker.
    assert.deepEqual(Object.keys(sent.body.headers).sort(), ['authorization', 'content-type', 'x-request-id'])
    assert.equal(sent.body.headers.authorization, `Bearer ${account.token}`)
    assert.equal(sent.body.headers['content-type'], 'application/json')
    assert.match(sent.body.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    // The same FE 0.3.49 body the direct path posts.
    const body = JSON.parse(sent.body.body)
    assert.deepEqual(body, {
        chatId: '', models: [MODEL], project_id: '', timestamp: body.timestamp, chat_type: 't2t', chat_mode: 'normal'
    })
    assert.ok(Math.abs(body.timestamp - Date.now()) < 10000)
    assert.deepEqual(logs, [])
})

test('the transport follows CHAT_CREATION_TRANSPORT: direct, or auto without a configured worker, keep the axios path', async () => {
    directReply = async () => ({ status: 200, data: chat('direct-chat'), headers: {} })
    for (const [transport, configured] of [['direct', true], ['auto', false]]) {
        worker.calls.length = 0
        direct.length = 0
        config.chatCreationTransport = transport
        config.signinWorkerConfigured = configured
        const account = givenAccount()
        assert.equal(await generateChatID(account.token, MODEL, account), 'direct-chat', `${transport}/${configured}`)
        assert.equal(worker.calls.length, 0, `${transport}/${configured}: the worker is not involved`)
        assert.equal(direct.length, 1)
        assert.equal(direct[0].url, CHATS_NEW)
    }
})

test('an egress target off the chat origin is refused before the worker hears about it', async () => {
    const account = givenAccount()
    const chatBaseUrl = config.qwenChatProxyUrl
    config.qwenChatProxyUrl = 'https://chat.stand.test:8444'
    try {
        await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_transport_error' })
    } finally {
        config.qwenChatProxyUrl = chatBaseUrl
    }
    assert.equal(worker.calls.length, 0)
    assert.deepEqual(direct, [])
})

/* --------------------------------------------------------- classification -- */

// The categories are the direct path's (tests/chat-creation-errors.test.js));
// the upstream's body merely arrives inside the worker's answer. The columns:
// the answer goes with a reload and one retry; a session refused again as
// unauthorized escalates to a password sign-in, nothing else does.
const CLASSIFIED = [
    ['unauthorized', unauthorized, 'upstream_session_unauthorized', 502, true, true],
    ['HTTP 401 with the unauthorized envelope', () => egress({ success: false, code: 'unauthorized' }, [], 401), 'upstream_session_unauthorized', 502, true, true],
    ['HTTP 401 with a body that is not the envelope', () => egress('', [], 401), 'upstream_invalid_response', 502, false, false],
    ['WAF HTML', () => egress(`<html><meta name="aliyun_waf_aa" content="${SECRET}"></html>`), 'upstream_waf_challenge', 503, true, false],
    ['unrelated HTML', () => egress(`<html><title>Help with captcha</title><body>${SECRET}</body></html>`), 'upstream_invalid_response', 502, false, false],
    ['unknown JSON error', () => egress({ success: false, data: { code: SECRET, message: SECRET } }), 'upstream_invalid_response', 502, false, false],
    ['HTTP 403 with an unreadable body', () => egress('<xml>' + SECRET + '</xml>', [], 403), 'upstream_invalid_response', 502, false, false]
]

for (const [name, reply, code, status, recoverable, escalates] of CLASSIFIED) {
    test(`egress answer: ${name} throws the direct path's typed category, with nothing else`, async () => {
        const account = givenAccount()
        worker.script.egress = () => reply()
        await assert.rejects(generateChatID(account.token, MODEL, account), error => {
            assert.ok(error instanceof ChatCreationError)
            assert.equal(error.code, code)
            assert.equal(error.status, status)
            assert.equal(error.response, undefined)
            assert.equal(error.cause, undefined)
            assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET))
            return true
        })
        // A refusal a reload can heal gets its one retry; the others do not.
        assert.equal(worker.count('/egress'), recoverable ? 2 : 1)
        assert.equal(worker.count('/renew'), recoverable ? 1 : 0)
        // A password is spent on a refused session only — never on a challenge
        // or an answer nobody could read.
        await until(() => sessionPersistence.renewals.size === 0)
        assert.equal(worker.count('/session'), escalates ? 1 : 0)
        assert.deepEqual(direct, [], 'a refused call is never replayed from plain Node TLS')
        assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET))
        assert.ok(logs.some(args => args[1] === 'CHAT' && String(args[0]).includes(`category=${code}`)), 'safe log keeps the category')
    })
}

test('a malformed worker answer is a transport failure', async () => {
    const account = givenAccount()
    for (const body of [{ status: 200, body: { bogus: true }, cookies: [] }, { status: '200', body: '{}', cookies: [] }, { status: 200, body: '{}' }]) {
        worker.script.egress = () => ok(body)
        await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_transport_error', status: 503 })
    }
    assert.deepEqual(direct, [])
})

test('a worker that cannot serve the call is a loud 503, never a direct request', async () => {
    const account = givenAccount()
    const failures = [
        ['page_closed', refused(502, 'page_closed')], ['egress_failed', refused(502, 'egress_failed')],
        ['egress_timeout', refused(504, 'egress_timeout')], ['resident_capacity', refused(503, 'resident_capacity')],
        ['browser_error', refused(500, 'browser_error')]
    ]
    for (const transport of ['auto', 'browser']) {
        config.chatCreationTransport = transport
        for (const [code, reply] of failures) {
            worker.calls.length = 0
            logs.length = 0
            worker.script.egress = () => reply
            await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_transport_error', status: 503 })
            assert.equal(worker.count('/renew'), 0, 'a worker failure is not a refused session')
            assert.deepEqual(direct, [], `${transport}: ${code} must not fall back to plain Node TLS`)
            assert.ok(logs.some(args => args[1] === 'CHAT' &&
                String(args[0]).includes(`CHAT_CREATION_TRANSPORT=${transport}`) && String(args[0]).includes(code)),
            `${transport}: ${code} is logged with the worker code`)
        }
        // The worker itself gone: connection refused.
        worker.calls.length = 0
        logs.length = 0
        const address = config.signinWorkerUrl
        config.signinWorkerUrl = 'http://127.0.0.1:1'
        try {
            await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_transport_error', status: 503 })
        } finally {
            config.signinWorkerUrl = address
        }
        assert.deepEqual(direct, [])
        assert.ok(logs.some(args => args[1] === 'CHAT' && String(args[0]).includes(`CHAT_CREATION_TRANSPORT=${transport}`)))
    }
})

/* ----------------------------------------------------------------- jar sync -- */

test('the jar the worker returns is folded into the session: server-set wins, the rest survives, storage follows', async t => {
    const account = givenAccount()
    current().jar = store.jarFromCookies([cookie('cna', 'initial'), cookie('legacy', 'keep', '.qwen.ai')])
    worker.script.egress = () => egress(chat('chat-1'), [
        cookie('cna', 'rotated'), cookie('ssxmod_itna', SECRET), cookie('authsess', 'new', 'auth.qwen.ai')
    ])
    await withStorage(t, async ({ persistence, readSessions }) => {
        // The write-through is not awaited by the caller. The test waits for it
        // by its promise: reading the file while it is being replaced is what
        // makes the replace fail on Windows (EPERM on rename).
        const writes = []
        const save = persistence.saveV2Session.bind(persistence)
        persistence.saveV2Session = (...args) => { const write = save(...args); writes.push(write); return write }

        await generateChatID(account.token, MODEL, account)
        assert.deepEqual(jarPairs('https://chat.qwen.ai/'), { legacy: 'keep', cna: 'rotated', ssxmod_itna: SECRET })
        assert.deepEqual(jarPairs('https://auth.qwen.ai/'), { legacy: 'keep', authsess: 'new' })
        assert.equal(writes.length, 1)
        await Promise.all(writes)
        const stored = (await readSessions())[EMAIL]
        assert.equal(stored.token, account.token, 'the sync rewrites the jar, not the session')
        assert.ok(stored.jar.cookies.some(item => item.key === 'cna' && item.value === 'rotated'), 'storage holds the browser jar')

        // Nothing rotated: nothing is written.
        await generateChatID(account.token, MODEL, account)
        assert.equal(writes.length, 1)
    })
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET), 'a cookie value never reaches a log')
})

test('a direct chats/new in browser mode folds its Set-Cookie into the session jar', async () => {
    config.chatCreationTransport = 'direct'
    const account = givenAccount()
    directReply = async () => ({ status: 200, data: chat('direct-chat'), headers: {
        'set-cookie': ['ssxmod_itna=direct-1; Path=/; Secure', 'cna=c2; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/']
    } })
    assert.equal(await generateChatID(account.token, MODEL, account), 'direct-chat')
    assert.deepEqual(jarPairs('https://chat.qwen.ai/'), { cna: 'c2', ssxmod_itna: 'direct-1' })

    // Joined into one header (an HTTP/2 client or a proxy may do that): the
    // comma inside the Expires date is not a cookie boundary.
    directReply = async () => ({ status: 200, data: chat('direct-chat'), headers: {
        'set-cookie': 'acw_tc=a1; Path=/, tfstk=t1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/'
    } })
    await generateChatID(account.token, MODEL, account)
    assert.deepEqual(jarPairs('https://chat.qwen.ai/'), { acw_tc: 'a1', cna: 'c2', ssxmod_itna: 'direct-1', tfstk: 't1' })
    assert.equal(worker.calls.length, 0)
})

test('direct completions fold their Set-Cookie into the session jar, answered or refused', async () => {
    config.chatCreationTransport = 'direct'
    const account = givenAccount()
    directReply = async url => url.startsWith(COMPLETIONS)
        ? { status: 200, headers: { 'set-cookie': ['isg=answered; Path=/'] }, data: Readable.from(['data: [DONE]\n\n']) }
        : { status: 200, data: chat('direct-chat'), headers: {} }
    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    result.response.destroy()
    assert.equal(jarPairs('https://chat.qwen.ai/').isg, 'answered')

    const failure = new Error('Request failed with status code 401')
    failure.response = { status: 401, headers: { 'set-cookie': ['isg=refused; Path=/'] }, data: '' }
    directReply = async url => {
        if (url.startsWith(COMPLETIONS)) throw failure
        return { status: 200, data: chat('direct-chat'), headers: {} }
    }
    // The 401 also invalidates the session. Inside the interval of a recovery
    // the invalidation is a no-op, which is what keeps the jar inspectable.
    config.sessionRecoveryMinIntervalMs = 60000
    worker.script.renew = () => refused(500, 'browser_error')
    await sessionPersistence.recoverSession(EMAIL, account, 'test')
    assert.equal((await sendChatRequest(BODY, { currentAccount: account })).status, false)
    assert.equal(jarPairs('https://chat.qwen.ai/').isg, 'refused')
})

/* ---------------------------------------------------------------- recovery -- */

test('an unauthorized chats/new is recovered inside the request: live reload, then exactly one retry', async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    const replies = [unauthorized(), egress(chat('chat-after-reload'), [cookie('ssxmod_itna', 'after-reload')])]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)

    assert.equal(await generateChatID(account.token, MODEL, account), 'chat-after-reload')
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/renew')[0], { email: EMAIL, proxy: null, force: true })
    assert.equal(worker.sent('/egress')[1].headers.authorization, `Bearer ${renewed.token}`)
    // The retry's jar is folded in like any other answer.
    assert.equal(jarPairs('https://chat.qwen.ai/').ssxmod_itna, 'after-reload')
    assert.deepEqual(direct, [])
})

test('a WAF challenge on egress gets the reload and the retry — and never a password', async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    const replies = [challenged(), egress(chat('after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)
    assert.equal(await generateChatID(account.token, MODEL, account), 'after-reload')
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.equal(worker.sent('/renew')[0].force, true)
    assert.equal(worker.sent('/egress')[1].headers.authorization, `Bearer ${renewed.token}`)
    assert.equal(worker.count('/session'), 0)
})

test('a WAF challenge that outlasts the reload is not answered with logins', async () => {
    config.sessionReloginMinIntervalMs = 0
    const account = givenAccount()
    worker.script.egress = () => challenged()
    worker.script.renew = () => ok(harvested('renewed'))
    // A challenge page where the chat root should be: the worker can only
    // report it as a profile that produced no token.
    const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_waf_challenge', status: 503 })
    await fail()
    // Reload, retry, challenge. Nothing else: no escalation, no drop.
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.ok(current(), 'the session is not dropped over a challenge')

    // Each later failure (one recovery per interval) is a reload again.
    config.sessionRecoveryMinIntervalMs = 0
    await fail()
    await fail()
    assert.deepEqual(worker.routes().slice(3), ['/egress', '/renew', '/egress', '/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0, 'not one password login for a challenge')

    // Not even a reload that fails as session_expired leads to one: after a
    // challenge that is the challenge page, not a dead profile.
    worker.script.renew = () => refused(422, 'session_expired')
    await fail()
    assert.equal(worker.count('/session'), 0)
    assert.equal(worker.count('/renew'), 4, 'the reload was tried')
})

test('the renewed session takes the account record with it, in memory and in storage', async t => {
    const account = givenAccount()
    accountManager.accountTokens.push(account)
    accountManager.accountRotator.setAccounts(accountManager.accountTokens)
    const renewed = harvested('renewed')
    const replies = [unauthorized(), egress(chat('chat-after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)
    await withStorage(t, async ({ persistence, readAccounts, readSessions }) => {
        assert.equal(await persistence.saveAccount(EMAIL, { password: PASSWORD, token: account.token }, { allowCreate: true }), true)
        // The request returns only once the renewal and the adoption have been written.
        await generateChatID(account.token, MODEL, account)
        // Every holder of the account object — rotation, a request already in flight — now sees the live token.
        assert.equal(accountManager.accountTokens[0], account)
        assert.equal(account.token, renewed.token)
        assert.equal(account.expires, renewed.expiresAt)
        assert.equal(current().token, renewed.token)
        assert.equal((await readAccounts()).find(item => item.email === EMAIL).password, PASSWORD, 'only the token fields are written')
        assert.equal((await readAccounts()).find(item => item.email === EMAIL).token, renewed.token)
        assert.equal((await readSessions())[EMAIL].token, renewed.token)
    })
})

test('adoption is in memory first: storage that refuses the token costs a warning, not the request', async t => {
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const renewed = harvested('renewed')
    const replies = [unauthorized(), egress(chat('chat-after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)
    await withStorage(t, async () => {
        const save = accountManager.dataPersistence.saveAccount
        accountManager.dataPersistence.saveAccount = async () => false
        try {
            assert.equal(await generateChatID(account.token, MODEL, account), 'chat-after-reload')
        } finally {
            accountManager.dataPersistence.saveAccount = save
        }
        assert.equal(account.token, renewed.token)
        assert.ok(logs.some(args => args[1] === 'V2SESSION' && /не сохранён/.test(String(args[0]))), 'the undurable token is reported')
    })
})

test('a generation that began on the refused token continues on the renewed one', async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    const replies = [unauthorized(), egress(chat('chat-after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)
    directReply = async url => {
        assert.equal(url, `${COMPLETIONS}chat-after-reload`)
        return { status: 200, headers: {}, data: Readable.from(['data: [DONE]\n\n']) }
    }

    const result = await sendChatRequest(BODY, { currentAccount: account })
    try {
        // prepareChat accepts the session for this token: no 409 v2_session_required.
        assert.equal(result.status, true)
        assert.equal(result.chatId, 'chat-after-reload')
        assert.equal(result.currentToken, renewed.token)
        assert.equal(direct.length, 1)
        assert.equal(direct[0].headers.Authorization, `Bearer ${renewed.token}`)
        assert.ok(direct[0].headers.cookie.split(/;\s*/).includes(`token=${renewed.token}`))
    } finally {
        result.response.destroy()
    }
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
})

test('still refused after the reload: one retry, then the failure; the full re-login follows in the background', async () => {
    const account = givenAccount()
    const signedIn = harvested('signed-in')
    worker.script.egress = () => unauthorized()
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized', status: 502 })
    // The request itself saw one reload and one retry; the re-login is not on its path.
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])

    await until(() => worker.count('/session') === 1)
    assert.deepEqual(worker.sent('/session')[0], { email: EMAIL, password: PASSWORD, proxy: null, force: true })
    await until(() => current()?.token === signedIn.token)
    assert.equal(account.token, tokenWith('initial'), 'an account the manager does not know is left alone')
    // The request kept its own failure; nothing was replayed directly.
    assert.deepEqual(direct, [])
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET))
})

test('a dead profile is re-logged in with the password before the retry', async () => {
    const signedIn = harvested('signed-in')
    for (const [status, code] of [[404, 'no_profile'], [422, 'session_expired']]) {
        worker.calls.length = 0
        const account = givenAccount()
        accountManager.accountTokens = [account]
        const replies = [unauthorized(), egress(chat('after-relogin'))]
        worker.script.egress = () => replies.shift()
        worker.script.renew = () => refused(status, code)

        assert.equal(await generateChatID(account.token, MODEL, account), 'after-relogin', code)
        assert.deepEqual(worker.routes(), ['/egress', '/renew', '/session', '/egress'], code)
        assert.deepEqual(worker.sent('/session')[0], { email: EMAIL, password: PASSWORD, proxy: null, force: true })
        assert.equal(worker.sent('/egress')[1].headers.authorization, `Bearer ${signedIn.token}`)
        assert.equal(account.token, signedIn.token)
    }
})

test('a resident page that cannot authenticate (session_expired on the lazy open) is recovered too', async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    const replies = [refused(422, 'session_expired'), egress(chat('after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)
    assert.equal(await generateChatID(account.token, MODEL, account), 'after-reload')
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.equal(worker.sent('/egress')[1].headers.authorization, `Bearer ${renewed.token}`)
})

test('a reload that fails outright leaves the failure with the request and the session where it was', async () => {
    const account = givenAccount()
    worker.script.egress = () => unauthorized()
    // The browser flow may also hand back something that is not a session.
    for (const reply of [refused(500, 'browser_error'), refused(502, 'page_closed'), ok({ token: 'not-a-jwt', expiresAt: 1, cookies: [] })]) {
        worker.calls.length = 0
        givenAccount()
        sessionPersistence.resetRecoveryForTests()
        const session = current()
        worker.script.renew = () => reply
        await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
        assert.equal(worker.count('/egress'), 1, 'nothing was recovered, so nothing was retried')
        assert.equal(worker.count('/session'), 0, 'a broken worker is not a dead profile')
        assert.equal(current(), session, 'the refused session stays: dropping it would only leave 409s behind')
    }
})

test('without a session the call is refused locally, unless one recovery produces one', async () => {
    const account = { email: EMAIL, password: PASSWORD, token: tokenWith('initial') }
    const renewed = harvested('renewed')
    worker.script.renew = () => refused(500, 'browser_error')
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'v2_session_required', status: 409 })
    assert.equal(worker.count('/egress'), 0, 'the page is never asked without a session')

    worker.calls.length = 0
    sessionPersistence.resetRecoveryForTests()
    worker.script.renew = () => ok(renewed)
    assert.equal(await generateChatID(account.token, MODEL, account), 'chat-1')
    assert.deepEqual(worker.routes(), ['/renew', '/egress'])
    assert.equal(worker.sent('/egress')[0].headers.authorization, `Bearer ${renewed.token}`)
})

/* ------------------------------------------------------------ bounded load -- */

test('one recovery per interval: a request failing inside the window does not reload the page again', async () => {
    const account = givenAccount()
    const session = current()
    config.sessionRecoveryMinIntervalMs = 60000
    worker.script.egress = () => unauthorized()
    worker.script.renew = () => refused(500, 'browser_error')
    const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })

    await fail()
    assert.equal(worker.count('/renew'), 1)
    await fail()
    await fail()
    assert.equal(worker.count('/renew'), 1, 'the reload is not repeated for every failing request')
    assert.equal(worker.count('/egress'), 3, 'and a throttled request is not retried either')
    assert.equal(current(), session)
    assert.deepEqual(direct, [])

    // The window over, the next failure recovers again.
    config.sessionRecoveryMinIntervalMs = 0
    await fail()
    assert.equal(worker.count('/renew'), 2)
    assert.equal(worker.count('/egress'), 4)
})

test('the full re-login is rate-limited per account; while it has to wait, the reload is what is left', async () => {
    const account = givenAccount()
    config.sessionReloginMinIntervalMs = 60000
    worker.script.egress = () => unauthorized()
    // A dead profile: the reload cannot succeed, only the sign-in can.
    worker.script.renew = () => refused(404, 'no_profile')
    const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })

    // Reload, sign-in, retry; the refused retry escalates, and the sign-in it
    // asks for has to wait — so a reload runs instead.
    await fail()
    await until(() => sessionPersistence.renewals.size === 0)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/session', '/egress', '/renew'])
    await fail()
    await fail()
    assert.equal(worker.count('/session'), 1, 'one password login per interval, however many requests fail')
    // Each further failure gets the reload and its own refusal: no retry, no password.
    assert.deepEqual(worker.routes().slice(5), ['/egress', '/renew', '/egress', '/renew'])
    assert.ok(logs.some(args => args[1] === 'V2SESSION' && /отложен/.test(String(args[0]))), 'the skipped re-login is logged')
})

// Advance the clock, let one request fail, and count the sign-ins it cost.
const withRecoveryClock = async fn => {
    let now = Date.now()
    sessionPersistence.setRecoveryClockForTests(() => now)
    try {
        return await fn(advanceMs => { now += advanceMs })
    } finally {
        sessionPersistence.setRecoveryClockForTests(null)
    }
}

test('an account nothing helps backs off: every sign-in that does not stick doubles the wait, up to the refresh cadence', { timeout: 10000 }, async () => {
    await withRecoveryClock(async advance => {
        config.sessionReloginMinIntervalMs = 60000
        const account = givenAccount()
        worker.script.egress = () => unauthorized()
        // A dead profile: every recovery is a password login, and qwen.ai refuses its session again.
        worker.script.renew = () => refused(404, 'no_profile')
        const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
        const loginsFor = async advanceMs => {
            const before = worker.count('/session')
            advance(advanceMs)
            await fail()
            await until(() => sessionPersistence.renewals.size === 0)
            return worker.count('/session') - before
        }

        // Sign-in, refused retry: the first wait is already doubled.
        await fail()
        await until(() => sessionPersistence.renewals.size === 0)
        assert.equal(worker.count('/session'), 1)
        assert.equal(await loginsFor(119_000), 0, 'inside the doubled minute: the reload answers instead')
        assert.equal(await loginsFor(1_000), 1, 'then the profile is tried again')
        // Every refused sign-in doubles the wait again.
        assert.equal(await loginsFor(239_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        assert.equal(await loginsFor(479_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        // Eight minutes would be sixteen: it stays at the ceiling, fifteen.
        assert.equal(await loginsFor(899_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        assert.equal(await loginsFor(899_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        assert.equal(worker.count('/session'), 6)

        // qwen.ai accepts a session again: the account starts over at one minute.
        const answers = [unauthorized(), egress(chat('accepted'))]
        worker.script.egress = () => answers.shift()
        advance(900_000)
        assert.equal(await generateChatID(account.token, MODEL, account), 'accepted')
        // Refused again from here on: the account starts over at one minute.
        worker.script.egress = () => unauthorized()
        assert.equal(await loginsFor(0), 0)
        assert.equal(await loginsFor(61_000), 1, 'back to the base interval')
        assert.equal(worker.count('/session'), 8)
    })
})

test('a sign-in that fails backs off exactly like one whose session is refused', { timeout: 10000 }, async () => {
    await withRecoveryClock(async advance => {
        config.sessionReloginMinIntervalMs = 60000
        const account = givenAccount()
        worker.script.egress = () => unauthorized()
        worker.script.renew = () => refused(404, 'no_profile')
        const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
        const loginsFor = async advanceMs => {
            const before = worker.count('/session')
            advance(advanceMs)
            await fail()
            await until(() => sessionPersistence.renewals.size === 0)
            return worker.count('/session') - before
        }

        // What a sign-in can end in: a wrong password, a captcha that sticks,
        // the worker's login line, a browser that broke. Each is an attempt,
        // and each doubles the wait for the next one.
        worker.script.session = () => refused(401, 'invalid_credentials')
        assert.equal(await loginsFor(0), 1, 'the attempt is made')
        assert.equal(await loginsFor(60_000), 0, 'a wrong password is not tried again at the base minute')
        assert.equal(await loginsFor(60_000), 1, 'only after the doubled wait')
        worker.script.session = () => refused(502, 'captcha_stuck')
        assert.equal(await loginsFor(239_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        worker.script.session = () => refused(429, 'signin_paced')
        assert.equal(await loginsFor(479_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        worker.script.session = () => refused(500, 'browser_error')
        // Eight minutes would be sixteen: the ceiling is fifteen.
        assert.equal(await loginsFor(899_000), 0)
        assert.equal(await loginsFor(1_000), 1)
        assert.equal(worker.count('/session'), 5)
        assert.deepEqual(worker.sent('/session').map(body => body.force), [true, true, true, true, true])
        assert.ok(logs.some(args => args[1] === 'V2SESSION' && /signin_busy \(signin_paced\)/.test(String(args[0]))), 'the worker code reaches the log')
    })
})

test('parallel failures on one account share a single reload and all retry on the renewed token', { timeout: 10000 }, async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    const answers = [unauthorized(), unauthorized(), unauthorized(), egress(chat('shared')), egress(chat('shared')), egress(chat('shared'))]
    worker.script.egress = () => answers.shift()
    let release
    worker.script.renew = () => new Promise(resolve => { release = () => resolve(ok(renewed)) })

    const pending = [1, 2, 3].map(() => generateChatID(account.token, MODEL, account))
    await until(() => worker.count('/egress') === 3)
    await until(() => worker.count('/renew') === 1)
    release()
    assert.deepEqual(await Promise.all(pending), ['shared', 'shared', 'shared'])
    assert.equal(worker.count('/renew'), 1)
    assert.deepEqual(worker.routes().slice(-3), ['/egress', '/egress', '/egress'])
    assert.ok(worker.sent('/egress').slice(-3).every(body => body.headers.authorization === `Bearer ${renewed.token}`))
})

test('a request refused on a token a sibling already replaced retries on the new one, with no recovery of its own', { timeout: 10000 }, async () => {
    const account = givenAccount()
    const renewed = harvested('renewed')
    // First answers, in order: the refusal that starts the recovery; the one
    // held until the recovery is over; then the two retries.
    let calls = 0
    const held = []
    worker.script.egress = () => {
        calls++
        if (calls === 1) return unauthorized()
        if (calls === 2) return new Promise(resolve => { held.push(() => resolve(unauthorized())) })
        return egress(chat(`chat-${calls}`))
    }
    let releaseRenew
    worker.script.renew = () => new Promise(resolve => { releaseRenew = () => resolve(ok(renewed)) })

    const first = generateChatID(account.token, MODEL, account)
    await until(() => worker.count('/renew') === 1)
    // Still on the old session: the renewal has not landed yet.
    const second = generateChatID(account.token, MODEL, account)
    await until(() => held.length === 1)
    releaseRenew()
    assert.equal(await first, 'chat-3')

    // Its call went out on the old token and comes back refused after the
    // store has moved on: that is not this account's session being bad.
    for (const release of held) release()
    assert.equal(await second, 'chat-4')
    // Two calls each, and the one renewal: the second request scheduled none.
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/egress', '/egress'])
    assert.equal(worker.sent('/egress')[3].headers.authorization, `Bearer ${renewed.token}`)
})

test('a session replaced under the same token is not "a new session": the refusal still needs a recovery', { timeout: 10000 }, async () => {
    config.sessionRecoveryMinIntervalMs = 60000
    const account = givenAccount()
    // The renewal hands back the same token in a new object, as the periodic refresh does.
    let releaseRenew
    worker.script.renew = () => new Promise(resolve => { releaseRenew = () => resolve(ok(harvested('initial'))) })
    let calls = 0
    const held = []
    worker.script.egress = () => {
        calls++
        if (calls === 1) return unauthorized()
        if (calls === 2) return new Promise(resolve => { held.push(() => resolve(unauthorized())) })
        return egress(chat(`chat-${calls}`))
    }

    const first = generateChatID(account.token, MODEL, account)
    await until(() => worker.count('/renew') === 1)
    const second = generateChatID(account.token, MODEL, account)
    await until(() => held.length === 1)
    releaseRenew()
    assert.equal(await first, 'chat-3')
    for (const release of held) release()

    // Same token, new object: retrying on it would replay the refusal. What
    // the request needs is a recovery — and inside the interval there is none.
    await assert.rejects(second, { code: 'upstream_session_unauthorized', status: 502 })
    assert.equal(worker.count('/egress'), 3, 'no retry on the token that was just refused')
    assert.equal(worker.count('/renew'), 1, 'and no second recovery inside the interval')
})

test('escalation is counted once per sign-in, not once per request that finds its session refused', { timeout: 10000 }, async () => {
    await withRecoveryClock(async advance => {
        config.sessionRecoveryMinIntervalMs = 60000
        config.sessionReloginMinIntervalMs = 60000
        const account = givenAccount()
        worker.script.renew = () => ok(harvested('renewed'))
        worker.script.session = () => ok(harvested('signed-in'))
        // Four requests whose first answers land together: one shared recovery,
        // four retries on its session.
        const burst = async () => {
            let calls = 0
            const first = []
            worker.script.egress = () => {
                calls++
                if (calls <= 4) return new Promise(resolve => { first.push(() => resolve(unauthorized())) })
                return unauthorized()
            }
            const pending = [1, 2, 3, 4].map(() =>
                assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' }))
            await until(() => first.length === 4)
            for (const go of first) go()
            await Promise.all(pending)
            await until(() => sessionPersistence.renewals.size === 0)
        }

        // Refused, reloaded, refused again: the account escalates, and the sign-in runs in the background.
        await burst()
        assert.equal(worker.count('/session'), 1)
        assert.equal(worker.count('/renew'), 1)

        // Four requests share the in-request sign-in, and all four of their
        // retries are refused: ONE failed sign-in, ONE doubling.
        advance(61_000)
        await burst()
        assert.equal(worker.count('/session'), 2, 'four requests, one sign-in')
        // The doubled wait has not passed: the reload answers, not a third sign-in.
        advance(61_000)
        await burst()
        assert.equal(worker.count('/session'), 2, 'four requests did not cost four doublings')
        // Only after twice the base interval.
        advance(61_000)
        await burst()
        assert.equal(worker.count('/session'), 3)
    })
})

test('through sendChatRequest an egress failure never drops the session either, recovery throttle or not', async t => {
    const account = givenAccount()
    worker.script.egress = () => unauthorized()
    // Recovery cannot even run: the session is exactly as refused as before.
    worker.script.renew = () => refused(500, 'browser_error')
    await withStorage(t, async ({ readSessions }) => {
        await sessionPersistence.publishSession(EMAIL, current())
        await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), { code: 'upstream_session_unauthorized' })
        assert.equal(current()?.token, account.token, 'the refused session stays in the store')
        assert.equal((await readSessions())[EMAIL].token, account.token, 'and on disk')
        assert.deepEqual(direct, [], 'nothing is replayed from plain Node TLS')
    })
})

test('a direct completions call refused with 401 leaves alone the session that egress just accepted', async () => {
    const account = givenAccount()
    const session = current()
    const failure = new Error('Request failed with status code 401')
    failure.response = { status: 401, headers: {}, data: '' }
    directReply = async url => {
        if (url.startsWith(COMPLETIONS)) throw failure
        assert.fail(`no direct call to ${url} is expected here`)
    }
    assert.equal((await sendChatRequest(BODY, { currentAccount: account })).status, false)
    assert.deepEqual(worker.routes(), ['/egress'])
    assert.equal(current(), session, 'chats/new accepted it a moment ago: a refusal of a direct call is not the session\'s doing')
})

test('once a reload did not help, the next recovery is a full sign-in, not another reload', async () => {
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const signedIn = harvested('signed-in')
    worker.script.egress = () => unauthorized()
    const fail = () => assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })

    await fail()
    await until(() => current()?.token === signedIn.token)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/session'])

    // A later failure goes straight to the password: reloading did not help
    // this account. (Its own retry is refused again, hence the third login.)
    await fail()
    await until(() => worker.count('/session') === 3)
    assert.deepEqual(worker.routes().slice(4), ['/egress', '/session', '/egress', '/session'])
    assert.equal(worker.count('/renew'), 1)
})

test('an accepted session ends the escalation: the next refusal is answered with a reload again', async () => {
    const account = givenAccount()
    const answers = [
        // Refused, reloaded, refused again: the account escalates to a re-login.
        unauthorized(), unauthorized(),
        // qwen.ai accepts the re-logged-in session.
        egress(chat('accepted')),
        // A later refusal starts over with a reload — not another password login.
        unauthorized(), egress(chat('recovered-again'))
    ]
    worker.script.egress = () => answers.shift()
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
    await until(() => sessionPersistence.renewals.size === 0 && current()?.token === tokenWith('signed-in'))
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/session'])

    assert.equal(await generateChatID(account.token, MODEL, account), 'accepted')
    assert.equal(await generateChatID(current().token, MODEL, account), 'recovered-again')
    assert.deepEqual(worker.routes().slice(4), ['/egress', '/egress', '/renew', '/egress'])
    assert.equal(worker.count('/session'), 1)
})

/* ---------------------------------------------------- the direct transport -- */

test('an unauthorized direct chats/new invalidates the session and renews it live, in the background', async () => {
    config.chatCreationTransport = 'direct'
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const renewed = harvested('renewed')
    directReply = refusedDirect
    worker.script.renew = () => ok(renewed)

    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
    assert.equal(current(), undefined, 'the refused session leaves the store at once')
    await until(() => current()?.token === renewed.token)
    assert.deepEqual(worker.sent('/renew')[0], { email: EMAIL, proxy: null, force: true })
    assert.equal(account.token, renewed.token)
    assert.equal(worker.count('/egress'), 0)
})

test('an invalidation inside the recovery interval changes nothing', async () => {
    config.sessionRecoveryMinIntervalMs = 60000
    const account = givenAccount()
    const answers = [unauthorized(), egress(chat('recovered'))]
    worker.script.egress = () => answers.shift()
    await generateChatID(account.token, MODEL, account)
    const recovered = current()

    // The direct path failing right after that recovery.
    config.chatCreationTransport = 'direct'
    directReply = refusedDirect
    await assert.rejects(generateChatID(recovered.token, MODEL, account), { code: 'upstream_session_unauthorized' })
    assert.equal(current(), recovered, 'the session is not dropped into a state nothing will renew')
    assert.equal(worker.count('/renew'), 1)
})

test('a WAF challenge on the direct path is not a verdict on the session: nothing is dropped, nothing is renewed', async () => {
    config.chatCreationTransport = 'direct'
    const account = givenAccount()
    const session = current()
    directReply = async () => ({ status: 200, data: '<html><meta name="aliyun_waf_aa" content="x"></html>', headers: {} })
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_waf_challenge' })
    assert.equal(current(), session, 'the challenge is the IP\'s or the request\'s doing, not the session\'s')
    assert.equal(worker.calls.length, 0, 'and it costs neither a reload nor a password')
})

/* --------------------------------- completions through the egress (Qwen2API-3ue.3) -- */

// The worker's streaming /egress as the app sees it: the test writes the
// relay's events (they wait for the app to open the relay), and learns when
// the app hung up — which is the app's whole way of saying "stop".
function relay() {
    const waiting = []
    let response = null
    let finishing = false
    let hangUp
    const hungUp = new Promise(resolve => { hangUp = resolve })
    const send = event => {
        if (response) response.write(`${JSON.stringify(event)}\n`)
        else waiting.push(event)
    }
    // The worker ends its answer with the stream's last event.
    const finish = event => {
        send(event)
        if (response) response.end()
        else finishing = true
    }
    return {
        // What the worker does with /egress {stream: true}: it owns the answer.
        open: (res, req) => {
            response = res
            res.writeHead(200, { 'content-type': 'application/x-ndjson' })
            // The connection going is what the worker watches too: a
            // server-side response does not emit 'close' under Bun, its socket does.
            const gone = () => hangUp(res.writableEnded)
            res.on('close', gone)
            req?.socket?.on('close', gone)
            for (const event of waiting.splice(0)) res.write(`${JSON.stringify(event)}\n`)
            if (finishing) res.end()
        },
        // qwen.ai's answer head: its status and headers, the jar as of then.
        head: (status = 200, headers = { 'content-type': SSE }, cookies = []) =>
            send({ type: 'head', status, url: `${COMPLETIONS}chat-1`, redirected: false, headers, cookies }),
        chunk: data => send({ type: 'chunk', data: Buffer.from(data).toString('base64') }),
        end: (cookies = []) => finish({ type: 'end', cookies }),
        fail: code => finish({ type: 'error', code, message: `In-page fetch failed (${code}).` }),
        // An event exactly as the test writes it, whatever it is.
        raw: send,
        // Resolves once the app closed its side of the relay, with whether the
        // answer had ended by then. It is the server seeing the connection
        // go — which a stand-in hosted by Bun does not report (Bun 1.3.11): the
        // worker is a Node process in production, and the gate runs this file
        // on Node.
        hungUp
    }
}

const SSE = 'text/event-stream'
const frame = delta => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
const DONE = 'data: [DONE]\n\n'
// An answer that starts well: the head with the jar, then a first frame.
const answering = () => {
    const stream = relay()
    stream.head(200, undefined, [cookie('cna', 'from-head')])
    stream.chunk(frame({ content: 'по' }))
    return stream
}
// An answer that refuses the session as an HTTP status, body and all.
const refusing = () => {
    const stream = relay()
    stream.head(401, { 'content-type': 'application/json' })
    stream.chunk(`{"code":"unauthorized","details":"${SECRET}"}`)
    stream.end()
    return stream
}
// The request's chats/new as always, and one relay per completions call, in order.
const scripted = (...streams) => {
    worker.script.egress = body => {
        if (body.stream !== true) return egress(chat('chat-1'))
        assert.ok(streams.length, 'more completions calls than the script has relays for')
        return streams.shift().open
    }
}
// The completions calls the app made, in order.
const completionsCalls = () => worker.sent('/egress').filter(body => body.stream === true)
// What the request charged the account with while `fn` ran — instead of
// charging the test's account manager.
async function charging(fn) {
    const charged = []
    const real = Object.fromEntries(BOOKKEEPING.map(name => [name, accountManager[name]]))
    for (const name of BOOKKEEPING) accountManager[name] = (...args) => { charged.push([name, ...args]) }
    try {
        return { value: await fn(), charged }
    } finally {
        for (const name of BOOKKEEPING) accountManager[name] = real[name]
    }
}
const BOOKKEEPING = ['recordAccountFailure', 'recordAccountError', 'recordAccountQuotaExhausted']
// The send settings a client's retry works with: one more try, right away.
const QUICK_RETRY = { count: 1, backoffMs: 0 }
const UNCLASSIFIED_503 = { rateLimited: false, overloaded: false, status: 503, retryAfter: null }
const UNCLASSIFIED_502 = { rateLimited: false, overloaded: false, status: 502, retryAfter: null }

test('COMPLETIONS_TRANSPORT=browser sends the call from the page and hands the answer on in the caller’s shape', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = answering()
    scripted(stream)

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(direct, [], 'no axios call reaches qwen.ai')
    const [creation, completions] = worker.sent('/egress')
    assert.equal(creation.stream, undefined, 'chats/new is the whole-answer call it was')
    assert.equal(worker.calls[1].auth, 'Bearer shared-secret')
    // What left the page: the v2.1 body the direct path builds, on the
    // session's token, with the headers chats/new sends.
    assert.equal(completions.email, EMAIL)
    assert.equal(completions.url, `${COMPLETIONS}chat-1`)
    assert.equal(completions.method, 'POST')
    assert.equal(completions.stream, true)
    assert.equal(completions.proxy, null)
    assert.equal(completions.timeoutMs, browserEgress.COMPLETIONS_TIMEOUT_MS)
    assert.deepEqual(Object.keys(completions.headers).sort(), ['authorization', 'content-type', 'x-request-id'])
    assert.equal(completions.headers.authorization, `Bearer ${account.token}`)
    assert.deepEqual(JSON.parse(completions.body), {
        model: MODEL, max_tokens: 64, stream: true, chat_id: 'chat-1', chatId: 'chat-1', parent_id: null, parentId: null,
        messages: [{ role: 'user', content: 'hello', parent_id: null, parentId: null }]
    })

    assert.equal(result.chatId, 'chat-1')
    // What the controllers get from either direct transport: a stream of the
    // body, the first frame already in it.
    assert.ok(result.response instanceof Readable)
    // The jar as of the head is in the session already.
    assert.equal(jarPairs(COMPLETIONS).cna, 'from-head')

    // The rest comes through as it arrives: frame by frame, not once it is all in.
    const events = result.response[Symbol.asyncIterator]()
    assert.equal((await events.next()).value.toString('utf8'), frame({ content: 'по' }))
    stream.chunk(frame({ content: 'нг' }))
    assert.equal((await events.next()).value.toString('utf8'), frame({ content: 'нг' }))
    stream.chunk(DONE)
    stream.end([cookie('ssxmod_itna', 'from-end')])
    assert.equal((await events.next()).value.toString('utf8'), DONE)
    assert.equal((await events.next()).done, true)
    assert.equal(jarPairs(COMPLETIONS).ssxmod_itna, 'from-end')
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(logs, [])
})

test('the transport answers in the shape axios and the impersonating transport use', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = answering()
    scripted(stream)

    const response = await browserEgress.postCompletions({
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', token: account.token, timeoutMs: 600000
    })
    assert.equal(response.status, 200)
    assert.equal(response.statusText, 'OK')
    assert.equal(response.headers['content-type'], SSE)
    assert.ok(response.data instanceof Readable)
    const events = response.data[Symbol.asyncIterator]()
    assert.equal((await events.next()).value.toString('utf8'), frame({ content: 'по' }))
    stream.end()
    assert.equal((await events.next()).done, true)
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('the relayed answer parses downstream exactly as a direct one does', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = relay()
    stream.head()
    // A frame cut inside a two-byte character: the relay carries bytes, and
    // the downstream decoder sees one stream of them.
    const whole = Buffer.from(frame({ content: 'привет' }))
    const cut = whole.indexOf(Buffer.from('п')) + 1
    stream.chunk(whole.subarray(0, cut))
    stream.chunk(whole.subarray(cut))
    stream.chunk(frame({ content: ' мир' }))
    stream.chunk(DONE)
    stream.end()
    scripted(stream)

    const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
    let content = ''
    const outcome = await consumeSSEStream(answer, parsed => {
        if (parsed.data === '[DONE]') return
        content += JSON.parse(parsed.data).choices[0].delta.content
    })
    assert.equal(content, 'привет мир')
    assert.equal(outcome.sawDone, true)
    assert.equal(outcome.completed, true)
})

test('a session refused in the answer’s first frame is recovered: live reload, then exactly one retry', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const refused = relay()
    refused.head()
    refused.chunk('data: {"code":"unauthorized"}\n\n')
    refused.chunk(`data: {"details":"${SECRET}"}\n\n`)
    scripted(refused, answering())

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    // The refused relay is hung up on: what follows its refusal is never read.
    assert.equal(await refused.hungUp, false)
    // The retry rides the renewed token, and so does everything after it.
    assert.equal(completionsCalls()[1].headers.authorization, `Bearer ${tokenWith('renewed')}`)
    assert.equal(result.currentToken, tokenWith('renewed'))
    assert.equal(current().token, tokenWith('renewed'))
    assert.equal(account.token, tokenWith('renewed'))
    // A reload is all it took: no password.
    assert.equal(worker.count('/session'), 0)
    assert.equal(JSON.stringify(logs).includes(SECRET), false, 'the refusal frame never reaches a log line')
})

test('a session refused as an HTTP status is recovered the same way', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    scripted(refusing(), answering())

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.equal(completionsCalls()[1].headers.authorization, `Bearer ${tokenWith('renewed')}`)
})

test('still refused after the reload: the request fails, and a completions refusal never costs a password', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    // For as many relays as the app asks.
    worker.script.egress = body => (body.stream === true ? refusing().open : egress(chat('chat-1')))

    const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(result.status, false)
    assert.deepEqual(result.failure, UNCLASSIFIED_502)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    // Not a sign-in, now or once the reload's bookkeeping has settled:
    // chats/new accepted this session a moment ago.
    assert.equal(worker.count('/session'), 0)
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
    // The session stays where the reload put it: not dropped into a 409 nobody renews.
    assert.equal(current()?.token, tokenWith('renewed'))
    // A refused session is a 4xx of the upstream's: the warn mark and nothing else.
    assert.deepEqual(charged, [['recordAccountError', EMAIL, 401]])
    assert.equal(JSON.stringify(logs).includes(SECRET), false, 'the refusal body never reaches a log line')
})

test('one recovery per interval: a completions refusal inside the window fails as it is, with no second reload', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    config.sessionRecoveryMinIntervalMs = 60000
    const account = givenAccount()
    worker.script.egress = body => (body.stream === true ? refusing().open : egress(chat('chat-1')))

    // The first refusal gets its reload and its retry.
    const first = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(first.value.status, false)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    const renewed = current()
    assert.equal(renewed.token, tokenWith('renewed'))

    // The next request lands inside the window: no reload on top of that one.
    const second = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(second.value.status, false)
    assert.deepEqual(second.value.failure, UNCLASSIFIED_502)
    // (Once anything the refusal scheduled behind the request has had its say.)
    await until(() => sessionPersistence.renewals.size === 0)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress', '/egress', '/egress'])
    assert.equal(worker.count('/session'), 0, 'and not a password either')
    assert.equal(current(), renewed)
    assert.deepEqual(second.charged, [['recordAccountError', EMAIL, 401]])
})

test('a completions call refused on a token a sibling already replaced retries on the new one, with no reload of its own', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const sibling = harvested('sibling')
    worker.script.egress = body => {
        if (body.stream !== true) return egress(chat('chat-1'))
        // The store moved on while this call was on its way out.
        if (current().token !== sibling.token) {
            store.setSession(EMAIL, { token: sibling.token, expiresAt: EXPIRES_AT, jar: store.jarFromCookies(sibling.cookies) })
            return refusing().open
        }
        return answering().open
    }

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'])
    assert.equal(completionsCalls()[1].headers.authorization, `Bearer ${sibling.token}`)
    assert.equal(result.currentToken, sibling.token)
})

test('with no session left in the store the call rides the token the caller holds', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    // A sibling's direct call may drop the session after this request was
    // checked against it (chats/new direct, completions through the worker).
    store.clearSessions()
    const stream = relay()
    stream.head()
    stream.chunk(frame({ content: 'по' }))
    stream.end()
    scripted(stream)

    const response = await transport.postCompletions(`${COMPLETIONS}chat-1`, {}, { timeout: 60000 },
      { account, token: account.token })
    assert.equal(completionsCalls()[0].headers.authorization, `Bearer ${account.token}`)
    const events = response.data[Symbol.asyncIterator]()
    assert.equal((await events.next()).value.toString('utf8'), frame({ content: 'по' }))
    assert.equal((await events.next()).done, true)
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('what qwen.ai did to the stream is charged to the account, exactly as it is on the direct transports', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    // The connection dropping under the body; qwen.ai silent past its budget.
    for (const [code, chargedAs] of [['egress_failed', 'ECONNRESET'], ['egress_timeout', 'ETIMEDOUT']]) {
        worker.calls.length = 0
        const failing = () => {
            const stream = relay()
            stream.head()
            stream.fail(code)
            return stream.open
        }
        worker.script.egress = body => (body.stream === true ? failing() : egress(chat('chat-1')))

        const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
        assert.equal(result.status, false, code)
        assert.deepEqual(result.failure, UNCLASSIFIED_503, code)
        assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'], `${code}: retried once`)
        // Not the egress's doing: the account carries it towards its cooldown,
        // as it carries a dropped socket on the direct path.
        assert.deepEqual(charged, [['recordAccountFailure', EMAIL, chargedAs]], code)
    }
})

test('a handed-off stream that nobody reads is cut in time, and takes nothing down with it', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    browserEgress.setTimingForTests({ relaySilenceMs: 40 })
    const account = givenAccount()
    const stream = answering()
    scripted(stream)

    const response = await browserEgress.postCompletions({
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', token: account.token, timeoutMs: 30
    })
    // Never read, never closed: the watchdog comes for it, and an 'error'
    // with no listener of its own would be the end of the process.
    await until(() => response.data.destroyed === true)
    assert.equal(response.data.errored.workerCode, 'relay_silent')
    assert.ok(logs.some(args => String(args[0]).includes('nobody reading it')), 'it leaves a line all the same')
})

test('a relay out of shape is the egress’s fault: no retry, nothing charged, a 503', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    // An old worker, which never heard of streams and answers whole.
    const { value: result, charged } = await charging(async () => {
        worker.script.egress = body => (body.stream === true ? egress(chat('whole')) : egress(chat('chat-1')))
        return sendChatRequest(BODY, { currentAccount: account })
    })
    assert.equal(result.status, false)
    assert.deepEqual(result.failure, UNCLASSIFIED_503)
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(charged, [])
    assert.ok(logs.some(args => String(args[0]).includes('relay_malformed')))

    // An event of no known kind once the answer is under way: the stream's
    // failure, and a transport's.
    const stream = answering()
    scripted(stream)
    const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
    const events = answer[Symbol.asyncIterator]()
    await events.next()
    stream.raw({ type: 'surprise' })
    await assert.rejects(events.next(), { code: 'EGRESS_RELAY_MALFORMED', workerCode: 'relay_malformed' })
})

test('an answer that is over inside the first-frame grace brings its jar all the same', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = relay()
    stream.head(200, { 'content-type': 'application/json' }, [cookie('cna', 'from-head')])
    // Not SSE, so no frame ever completes: the whole answer is read before the hand-off.
    stream.chunk('{"usage":{}}')
    stream.end([cookie('ssxmod_itna', 'from-end')])
    scripted(stream)

    const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(jarPairs(COMPLETIONS).ssxmod_itna, 'from-end')
    assert.equal((await text(answer)), '{"usage":{}}')
})

test('a relay that goes silent before its first frame is cut like one that goes silent after', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    browserEgress.setTimingForTests({ firstFrameMs: 2000, relaySilenceMs: 40 })
    const account = givenAccount()
    // qwen.ai answered and then said nothing — and the worker said nothing either.
    const mute = relay()
    mute.head()
    scripted(mute)

    await assert.rejects(browserEgress.postCompletions({
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', token: account.token, timeoutMs: 30
    }), error => error.code === 'ETIMEDOUT' && error.workerCode === 'relay_silent')
    // Cut before the hand-off, not parked on the first frame until its grace runs out.
    assert.equal(await mute.hungUp, false)
})

test('a dead profile behind the page is re-logged in with the password before the retry', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    // The page cannot be opened (no_profile), and the reload finds it logged out.
    worker.script.renew = () => refused(422, 'session_expired')
    const answers = [refused(404, 'no_profile'), answering().open]
    worker.script.egress = body => (body.stream === true ? answers.shift() : egress(chat('chat-1')))

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/session', '/egress'])
    assert.equal(completionsCalls()[1].headers.authorization, `Bearer ${tokenWith('signed-in')}`)
    assert.equal(worker.sent('/session')[0].force, true)
})

test('a worker that cannot serve the call is retried, then answered with a 503 that is not the account’s', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    for (const [status, code] of [[502, 'page_closed'], [503, 'resident_capacity'], [500, 'browser_error']]) {
        worker.calls.length = 0
        worker.script.egress = body => (body.stream === true ? refused(status, code) : egress(chat('chat-1')))

        const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
        assert.equal(result.status, false, code)
        assert.deepEqual(result.failure, UNCLASSIFIED_503, code)
        assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'], `${code}: one retry`)
        assert.deepEqual(charged, [], `${code}: the egress's failure, not the account's`)
        assert.ok(logs.some(args => String(args[0]).includes(code)), `${code}: the log says whose failure it was`)
        assert.deepEqual(direct, [], `${code}: never a direct request`)
    }
})

test('a worker refusing the call itself is a configuration: not retried, not recovered', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    const { value: result, charged } = await charging(async () => {
        worker.script.egress = body => (body.stream === true ? refused(401, 'unauthorized') : egress(chat('chat-1')))
        return sendChatRequest(BODY, { currentAccount: account })
    })
    assert.equal(result.status, false)
    assert.deepEqual(result.failure, UNCLASSIFIED_503)
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(charged, [])
    assert.equal(current().token, account.token)
})

test('a relay that fails before anything reached the client is retried like a dropped connection', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    const dropped = relay()
    dropped.head()
    dropped.fail('egress_timeout')
    scripted(dropped, answering())

    const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'])
    // A relay's failure is not a verdict on the session.
    assert.equal(worker.count('/renew'), 0)
    // A retried send that then went through is not a failure of anything.
    assert.deepEqual(charged, [])
})

test('a relay that fails once the answer is under way is the stream’s failure: nothing is replayed', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    const stream = answering()
    scripted(stream)

    const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
    const events = answer[Symbol.asyncIterator]()
    await events.next()
    stream.chunk(frame({ content: 'нг' }))
    await events.next()
    // The page died mid-answer.
    stream.fail('page_closed')
    await assert.rejects(events.next(), error => error.code === 'ECONNRESET' && error.workerCode === 'page_closed')
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
})

test('the consumer letting go of the answer ends the relay: the app hangs up on the worker', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()

    // However the consumer lets go — destroying the stream outright...
    const destroyed = answering()
    scripted(destroyed)
    const first = await sendChatRequest(BODY, { currentAccount: account })
    first.response.destroy()
    assert.equal(await destroyed.hungUp, false, 'the worker sees its app close the connection before the answer ended')

    // ...or doing what the agent paths do: stop reading after a frame.
    const stopped = relay()
    stopped.head()
    stopped.chunk(frame({ content: 'стоп' }))
    scripted(stopped)
    const second = await sendChatRequest(BODY, { currentAccount: account })
    const outcome = await consumeSSEStream(second.response, () => {}, { shouldStop: () => true })
    assert.equal(outcome.stopped, true)
    assert.equal(await stopped.hungUp, false)
    // Neither cost a reload or a password.
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress'])
})

test('a slow first frame is not waited for past the grace: the answer goes on as it is, refusal or not', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    browserEgress.setTimingForTests({ firstFrameMs: 40 })
    const account = givenAccount()
    const stream = relay()
    stream.head()
    scripted(stream)

    const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
    // Handed on with nothing in it yet: the client's stream is under way
    // while qwen.ai is still thinking.
    const events = answer[Symbol.asyncIterator]()
    const late = 'data: {"code":"unauthorized"}\n\n'
    stream.chunk(late)
    // Past the hand-off the frame is the caller's to read: a stream that
    // started is not started over.
    assert.equal((await events.next()).value.toString('utf8'), late)
    stream.end()
    assert.equal((await events.next()).done, true)
    assert.equal(worker.count('/renew'), 0)
})

test('only a refusal of the SESSION in the first frame is a recovery; any other first frame goes on', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const firstFrames = [
        frame({ content: 'unauthorized' }),
        'data: {"error":{"code":"invalid_request","message":"bad tool schema"}}\n\n',
        'data: {"success":false,"code":"RateLimited"}\n\n',
        ': keep-alive\n\n',
        DONE
    ]
    for (const first of firstFrames) {
        worker.calls.length = 0
        const stream = relay()
        stream.head()
        stream.chunk(first)
        stream.end()
        scripted(stream)

        const { response: answer } = await sendChatRequest(BODY, { currentAccount: account })
        const events = answer[Symbol.asyncIterator]()
        assert.equal((await events.next()).value.toString('utf8'), first)
        assert.equal((await events.next()).done, true)
        assert.deepEqual(worker.routes(), ['/egress', '/egress'], first)
    }
})

test('an HTML challenge as the answer is screened as a direct one is', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = relay()
    stream.head(200, { 'content-type': 'text/html; charset=utf-8' })
    stream.chunk(`<html><meta name="aliyun_waf_aa" content="${SECRET}"></html>`)
    stream.end()
    scripted(stream)

    await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), isWafChallengeError)
    assert.equal(worker.count('/renew'), 0)
    assert.equal(JSON.stringify(logs).includes(SECRET), false)
})

test('a 429 from qwen.ai is the quota, with its Retry-After, as it is on the direct transports', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = relay()
    stream.head(429, { 'content-type': 'application/json', 'retry-after': '7' })
    stream.chunk('{"error":"RateLimited"}')
    stream.end()
    scripted(stream)

    const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.deepEqual(result.failure, { rateLimited: true, overloaded: false, status: 429, retryAfter: 7 })
    assert.deepEqual(charged, [['recordAccountQuotaExhausted', EMAIL, 7]])
    assert.equal(worker.count('/renew'), 0)
})

test('a caller that brings no silence budget of its own gets the usual one', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = relay()
    stream.head()
    stream.chunk(frame({ content: 'по' }))
    stream.end()
    scripted(stream)

    const response = await transport.postCompletions(`${COMPLETIONS}chat-1`, {}, {}, { account, token: account.token })
    assert.equal(worker.sent('/egress')[0].timeoutMs, browserEgress.COMPLETIONS_TIMEOUT_MS)
    // Read to the end without a trip: an undefined budget must not arm the
    // silence watchdog for "NaN" milliseconds, which is to say at once.
    assert.equal((await text(response.data)), frame({ content: 'по' }))
})

test('a relay that stays silent past every budget the worker has is cut by the app', { timeout: 10000 }, async () => {
    browserEgress.setTimingForTests({ relaySilenceMs: 40 })
    const account = givenAccount()
    const stream = answering()
    scripted(stream)

    const response = await browserEgress.postCompletions({
        account, url: `${COMPLETIONS}chat-1`, body: '{}', token: account.token, timeoutMs: 30
    })
    const events = response.data[Symbol.asyncIterator]()
    await events.next()
    // The page would cut a silent upstream at 30 ms and the worker say so;
    // when neither does, the relay itself is gone.
    await assert.rejects(events.next(), error => error.code === 'ETIMEDOUT' && error.workerCode === 'relay_silent')
    assert.equal(await stream.hungUp, false)
})

test('with chats/new direct, a refused egress completions call leaves the session alone too', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    config.chatCreationTransport = 'direct'
    directReply = async () => ({ status: 200, data: chat('direct-chat'), headers: {} })
    const account = givenAccount()
    worker.script.egress = body => (body.stream === true ? refusing().open : egress(chat('chat-1')))

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, false)
    assert.equal(direct.length, 1)
    assert.equal(direct[0].url, CHATS_NEW)
    // The transport had its reload and retry; the caller's 401 bookkeeping
    // does not drop the session on top of it.
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.equal(current()?.token, tokenWith('renewed'))
})

test('COMPLETIONS_TRANSPORT=browser is a forced transport: a worker that is not there is never replaced by axios', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    // chats/new stays direct here, so that the only thing asked of a missing
    // worker is the completions call.
    config.chatCreationTransport = 'direct'
    directReply = async () => ({ status: 200, data: chat('direct-chat'), headers: {} })
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    config.signinWorkerUrl = 'http://127.0.0.1:1'
    try {
        const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
        assert.equal(result.status, false)
        assert.deepEqual(result.failure, UNCLASSIFIED_503)
        // The direct call is chats/new's and nothing else: plain Node TLS to
        // qwen.ai is what the egress exists to avoid.
        assert.deepEqual(direct.map(call => call.url), [CHATS_NEW])
        assert.deepEqual(charged, [])
        assert.ok(logs.some(args => String(args[0]).includes('worker_unreachable')))
    } finally {
        config.signinWorkerUrl = workerUrl
    }
})
