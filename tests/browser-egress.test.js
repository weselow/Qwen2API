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
const { ChatCreationError, isWafChallengeError, resetChatChallengeBreaker } = require('../src/utils/upstream-error')
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
// record of everything the app sent. Nothing here reaches qwen.ai, and a
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

// The page the worker keeps for the account, by the session it is on: a token,
// or null while it is logged out. The app brings no Bearer on an egress call
// (Qwen2API-jr9) — the worker sends the call on the page's own — so this, and
// nothing the app holds, is what qwen.ai answers a call by.
const page = { token: null }

// qwen.ai's verdict on a call of the page: refused unless the page is on a
// session and the call went out on it. A call that brings no Bearer does (it
// is one of the page's own); one that brings the Bearer of another session
// does not — as the app's did on 24.11, after the page had moved on from the
// token a renewal harvested.
const pageRefuses = body => !page.token ||
    (body.headers.authorization !== undefined && body.headers.authorization !== `Bearer ${page.token}`)

// The answer /renew or /session gives once it harvested a session. Forced,
// either is a reload of the page or a sign-in on it: the page is on that
// session from here on.
const sessionOnPage = (body, harvested) => {
    if (body.force === true) page.token = harvested.token
    return ok(harvested)
}

// Whether the app put a Bearer of its own on a call. It never does
// (Qwen2API-jr9): a retry rides the page's session, not a token of the store's.
const bringsBearer = body => 'authorization' in body.headers

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
    // The account's page is on the session the account was given, and answers
    // as the page does; a forced renewal reloads it, a forced sign-in signs it
    // in — either leaves it on the session it hands back.
    page.token = tokenWith('initial')
    worker.script.egress = body => (pageRefuses(body) ? unauthorized() : egress(chat('chat-1')))
    worker.script.renew = body => sessionOnPage(body, harvested('renewed'))
    worker.script.session = body => sessionOnPage(body, harvested('signed-in'))
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
    // A challenge one test answered must not pause the next one's requests.
    resetChatChallengeBreaker()
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
    // Nor its token: the call is one of the page's own and goes out on the page's Bearer (Qwen2API-jr9).
    assert.deepEqual(Object.keys(sent.body.headers).sort(), ['content-type', 'x-request-id'])
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
    // The retry is the same call again, on the reloaded page: no Bearer of the app's on either.
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
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
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
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

test('the renewed session still takes the account record with it where account.js is not a file: the compiled binary', async t => {
    // Production runs the app as a compiled Bun binary: there are no sources on
    // disk, and a lookup of account.js by its path throws. 24.11, prod: every
    // recovery renewed the session at the worker, was reported MODULE_NOT_FOUND,
    // and the request was never retried.
    const Module = require('node:module')
    const resolveFilename = Module._resolveFilename
    Module._resolveFilename = function (request, ...rest) {
        if (request === './account.js') {
            throw Object.assign(new Error("Cannot find module './account.js'"), { code: 'MODULE_NOT_FOUND' })
        }
        return resolveFilename.call(this, request, ...rest)
    }
    t.after(() => { Module._resolveFilename = resolveFilename })
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const renewed = harvested('renewed')
    const replies = [unauthorized(), egress(chat('chat-after-reload'))]
    worker.script.egress = () => replies.shift()
    worker.script.renew = () => ok(renewed)

    assert.equal(await generateChatID(account.token, MODEL, account), 'chat-after-reload', 'the recovery must not be what the request fails on')
    assert.equal(account.token, renewed.token)
    assert.equal(worker.count('/renew'), 1)
    assert.ok(!logs.some(args => args[1] === 'V2SESSION' && /续期失败/.test(String(args[0]))), 'the renewal is not reported as failed')
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
        assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
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
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
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
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false])
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

test('parallel failures on one account share a single reload and all retry after it, on no Bearer of the app\'s', { timeout: 10000 }, async () => {
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
    assert.deepEqual(worker.sent('/egress').slice(-3).map(bringsBearer), [false, false, false])
})

test('a request whose refusal lands after a sibling replaced the session retries after that recovery, with none of its own', { timeout: 10000 }, async () => {
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

    // Its call went out before the recovery and comes back refused once the
    // store has moved on — the sibling has reloaded the page meanwhile: that
    // is not this account's session being bad.
    for (const release of held) release()
    assert.equal(await second, 'chat-4')
    // Two calls each, and the one renewal: the second request scheduled none.
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/egress', '/egress'])
    // None of the four carried a Bearer: the retries ride the page the sibling reloaded.
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false, false])
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

test('a WAF challenge never reaches the password — not even on an account that waits for its next sign-in', async () => {
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const signedIn = harvested('signed-in')
    worker.script.egress = () => unauthorized()
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized' })
    await until(() => current()?.token === signedIn.token)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/session'])

    // The account now waits for its next sign-in. Its next chats/new is not
    // refused but challenged: that is a reload and one retry — and no password.
    worker.script.egress = () => challenged()
    await assert.rejects(generateChatID(current().token, MODEL, account), { code: 'upstream_waf_challenge', status: 503 })
    assert.deepEqual(worker.routes().slice(4), ['/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 1, 'a password was spent on a WAF challenge')
    // The account still waits for its sign-in where a refused session is concerned.
    worker.script.egress = () => unauthorized()
    await assert.rejects(generateChatID(current().token, MODEL, account), { code: 'upstream_session_unauthorized' })
    assert.equal(worker.count('/session'), 2)
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
    // page's own session, with the headers chats/new sends.
    assert.equal(completions.email, EMAIL)
    assert.equal(completions.url, `${COMPLETIONS}chat-1`)
    assert.equal(completions.method, 'POST')
    assert.equal(completions.stream, true)
    assert.equal(completions.proxy, null)
    assert.equal(completions.timeoutMs, browserEgress.COMPLETIONS_TIMEOUT_MS)
    // The app puts its own on the call — no Bearer: that one is the page's
    // (Qwen2API-jr9) — and the rest of what a request of the page's carries
    // is the worker's (Qwen2API-3ue.5), except the one the page's own
    // completions call differs in from its other XHRs.
    assert.deepEqual(Object.keys(completions.headers).sort(), ['accept', 'content-type', 'x-request-id'])
    assert.equal(completions.headers.accept, 'application/json')
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
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', timeoutMs: 600000
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
    // The retry is the same call again, on the reloaded page — no Bearer of
    // the app's on either; the renewed token is what everything after it rides.
    assert.deepEqual(completionsCalls().map(bringsBearer), [false, false])
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
    assert.deepEqual(completionsCalls().map(bringsBearer), [false, false])
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

test('a completions refusal that lands after a sibling replaced the session retries after that recovery, with no reload of its own', { timeout: 10000 }, async () => {
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
    // The refusal and the retry alike went out as the page's own: the store's token was on neither.
    assert.deepEqual(completionsCalls().map(bringsBearer), [false, false])
    assert.equal(result.currentToken, sibling.token)
})

test('with no session left in the store the call still goes out, on the page\'s session — no token of the caller\'s is needed', { timeout: 10000 }, async () => {
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

    const response = await transport.postCompletions(`${COMPLETIONS}chat-1`, {}, { timeout: 60000 }, { account })
    assert.deepEqual(completionsCalls().map(bringsBearer), [false])
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
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', timeoutMs: 30
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
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', timeoutMs: 30
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
    assert.deepEqual(completionsCalls().map(bringsBearer), [false, false])
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

test('a call a script of the page cut (page_fault, the relay’s last event) is retried and is not the account’s', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    Object.assign(config, { chatRetryCount: QUICK_RETRY.count, chatRetryBackoffMs: QUICK_RETRY.backoffMs })
    const account = givenAccount()
    worker.script.egress = body => (body.stream === true ? (() => { const stream = relay(); stream.fail('page_fault'); return stream.open })() : egress(chat('chat-1')))

    const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(result.status, false)
    assert.deepEqual(result.failure, UNCLASSIFIED_503)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'], 'one retry')
    assert.deepEqual(charged, [], 'the page’s doing, not the account’s')
    assert.ok(logs.some(args => String(args[0]).includes('page_fault')), 'the log says whose failure it was')
    // And nothing of the session was touched for it: no reload, no password.
    assert.equal(worker.count('/renew') + worker.count('/session'), 0)
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

// An answer that is a WAF challenge page, status 200 and all: what qwen.ai
// gave an API call through the page on 2026-11-24. The worker relays it whole.
// In two pieces, the marker in the second and after a blank line: a reader
// that stopped where a frame of a stream ends would never see it.
const challenging = (page = `<html>\n<head>\n</head>\n\n<body><meta name="aliyun_waf_aa" content="${SECRET}"></body></html>`) => {
    const stream = relay()
    stream.head(200, { 'content-type': 'text/html; charset=utf-8' })
    const cut = page.indexOf('\n\n') + 2
    stream.chunk(page.slice(0, cut))
    stream.chunk(page.slice(cut))
    stream.end()
    return stream
}

test('a WAF challenge page as the answer gets the live reload and exactly one retry', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    accountManager.accountTokens = [account]
    const challenged = challenging()
    scripted(challenged, answering())

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.deepEqual(completionsCalls().map(bringsBearer), [false, false])
    // A reload is all it took: no password — chats/new accepted this session a moment ago.
    assert.equal(worker.count('/session'), 0)
    assert.equal(JSON.stringify(logs).includes(SECRET), false, 'the challenge page never reaches a log line')
    // The client gets the retried answer: its first frame, and nothing of the page.
    const answer = result.response[Symbol.asyncIterator]()
    assert.equal((await answer.next()).value.toString('utf8'), frame({ content: 'по' }))
})

test('a challenge that outlasts the reload is screened as a direct one is — and never costs a password', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    // For as many relays as the app asks.
    worker.script.egress = body => (body.stream === true ? challenging().open : egress(chat('chat-1')))

    await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), isWafChallengeError)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.equal(worker.count('/session'), 0)
    assert.equal(JSON.stringify(logs).includes(SECRET), false)
})

test('an HTML answer is read whole even where its pieces come with a pause', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    // The first-frame grace is short here: a pause in the page longer than it must not end the reading.
    browserEgress.setTimingForTests({ firstFrameMs: 40 })
    const account = givenAccount()
    const page = `<html>\n<head>\n</head>\n\n<body><meta name="aliyun_waf_aa" content="${SECRET}"></body></html>`
    const first = page.indexOf('\n\n') + 2
    const stream = relay()
    stream.head(200, { 'content-type': 'text/html; charset=utf-8' })
    stream.chunk(page.slice(0, first))
    // The rest of the page comes after a pause longer than the grace.
    setTimeout(() => {
        stream.chunk(page.slice(first))
        stream.end()
    }, 150)
    scripted(stream, answering())

    const result = await sendChatRequest(BODY, { currentAccount: account })
    assert.equal(result.status, true, 'the page was given up on before its marker was in')
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
})

test('a challenge whose reload fails earns no password: the answer goes on as it is', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    worker.script.egress = body => (body.stream === true ? challenging().open : egress(chat('chat-1')))
    // The page cannot be reloaded: the profile is gone. For a refused SESSION
    // that would be the password's moment; for a challenge it never is.
    worker.script.renew = () => refused(404, 'no_profile')

    await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), isWafChallengeError)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0, 'a password was spent on a WAF challenge')
})

test('one recovery per interval: a challenge inside the window is answered as it is, with no second reload', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    config.sessionRecoveryMinIntervalMs = 60000
    const account = givenAccount()
    worker.script.egress = body => (body.stream === true ? challenging().open : egress(chat('chat-1')))

    await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), isWafChallengeError)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    await assert.rejects(sendChatRequest(BODY, { currentAccount: account }), isWafChallengeError)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress', '/egress', '/egress'])
    assert.equal(worker.count('/session'), 0)
})

test('an HTML answer that is no challenge goes on as it is: nothing is reloaded', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const maintenance = '<!doctype html><html><title>Maintenance</title></html>'
    scripted(challenging(maintenance))

    const response = await browserEgress.postCompletions({
        account, url: `${COMPLETIONS}chat-1`, body: '{"stream":true}', timeoutMs: 600000
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(await text(response.data), maintenance)
    assert.deepEqual(worker.routes(), ['/egress'])
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

    const response = await transport.postCompletions(`${COMPLETIONS}chat-1`, {}, {}, { account })
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
        account, url: `${COMPLETIONS}chat-1`, body: '{}', timeoutMs: 30
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

/* --------------- the Bearer is the page's own (Qwen2API-jr9) ---------------- */

// 24.11, prod (image 439c35b): the same chats/new passed on the page's token
// and was refused as unauthorized on the app's — the token a renewal
// harvested, which the page, changing its token as it boots, had moved on
// from. Why qwen.ai refused that one is not established (such a token passed
// from Node on 21.11); the fix stands on the observed pair alone, and on the
// worker sending a call that brings no Bearer on the page's own token.

// Every call of a request answered as the page's own: chats/new whole,
// completions as one relay — `answer`'s, or a refusal's.
const asThePage = (body, answer) => {
    const refused = pageRefuses(body)
    if (body.stream !== true) return refused ? unauthorized() : egress(chat('chat-1'))
    return (refused ? refusing() : answer).open
}

test('Qwen2API-jr9: chats/new carries no authorization and passes on the page\'s session while the store holds a token the page moved on from', async () => {
    const account = givenAccount()
    page.token = tokenWith('moved-on')
    assert.equal(await generateChatID(account.token, MODEL, account), 'chat-1')
    // Nothing of the app's is on the call, so nothing can go stale: one call, no reload, no password.
    assert.deepEqual(worker.routes(), ['/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false])
    // The store is left as it was: its token is the account record's business, not the call's.
    assert.equal(current().token, account.token)
    assert.deepEqual(logs, [])
})

test('Qwen2API-jr9: completions carry no authorization too: a token the page moved on from in the store costs neither a refusal nor a reload', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    page.token = tokenWith('moved-on')
    const stream = answering()
    worker.script.egress = body => asThePage(body, stream)

    const result = await sendChatRequest(BODY, { currentAccount: account })
    try {
        assert.equal(result.status, true)
        assert.equal((await result.response[Symbol.asyncIterator]().next()).value.toString('utf8'), frame({ content: 'по' }))
    } finally {
        result.response.destroy()
    }
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
    assert.equal(current().token, account.token)
})

test('Qwen2API-jr9: a page logged out — chats/new is refused, the page is reloaded, and exactly one retry, with no authorization, passes', async () => {
    const account = givenAccount()
    page.token = null
    assert.equal(await generateChatID(account.token, MODEL, account), 'chat-1')
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/renew')[0], { email: EMAIL, proxy: null, force: true })
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
    assert.equal(worker.count('/session'), 0)
})

test('Qwen2API-jr9: refused again after the reload — one retry with no authorization, then the failure, and the password sign-in in the background', async () => {
    const account = givenAccount()
    page.token = null
    // The reload hands back a session, but qwen.ai goes on refusing the page's.
    worker.script.renew = () => ok(harvested('renewed'))
    await assert.rejects(generateChatID(account.token, MODEL, account), { code: 'upstream_session_unauthorized', status: 502 })
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
    // The re-login is not on the request's path, and it is one.
    await until(() => worker.count('/session') === 1)
    assert.deepEqual(worker.sent('/session')[0], { email: EMAIL, password: PASSWORD, proxy: null, force: true })
    await until(() => current()?.token === tokenWith('signed-in'))
    assert.deepEqual(direct, [])
})

test('Qwen2API-jr9: completions on a page logged out — refused, reloaded, exactly one retry with no authorization, and it passes', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = answering()
    // The page loses its session between chats/new and completions.
    worker.script.egress = body => {
        if (body.stream !== true) {
            page.token = null
            return egress(chat('chat-1'))
        }
        return asThePage(body, stream)
    }

    const result = await sendChatRequest(BODY, { currentAccount: account })
    try {
        assert.equal(result.status, true)
    } finally {
        result.response.destroy()
    }
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false])
    assert.deepEqual(worker.sent('/renew')[0], { email: EMAIL, proxy: null, force: true })
    assert.equal(worker.count('/session'), 0, 'a reload is all it took')
})

test('Qwen2API-jr9: completions refused again after the reload — one retry with no authorization, the request fails, and no password is spent', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    // The page loses its session between chats/new and completions, and the
    // reload brings none back: every completions call is refused.
    worker.script.egress = body => {
        if (body.stream !== true) {
            page.token = null
            return egress(chat('chat-1'))
        }
        return refusing().open
    }
    worker.script.renew = () => ok(harvested('renewed'))

    const { value: result, charged } = await charging(() => sendChatRequest(BODY, { currentAccount: account }))
    assert.equal(result.status, false)
    assert.deepEqual(result.failure, UNCLASSIFIED_502)
    // A refused session is a 4xx of the upstream's: the warn mark and nothing else.
    assert.deepEqual(charged, [['recordAccountError', EMAIL, 401]])
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false])
    // Not now, and not once the reload's bookkeeping has settled: chats/new
    // accepted this session a moment ago.
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('Qwen2API-jr9: the app puts exactly content-type and x-request-id on /egress — plus accept: application/json on the stream — and never authorization', { timeout: 10000 }, async () => {
    config.completionsTransport = 'browser'
    const account = givenAccount()
    const stream = answering()
    scripted(stream)
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    const result = await sendChatRequest(BODY, { currentAccount: account })
    result.response.destroy()
    const [creation, completions] = worker.sent('/egress')
    assert.equal(creation.stream, undefined, 'chats/new is the whole-answer call')
    assert.deepEqual(Object.keys(creation.headers).sort(), ['content-type', 'x-request-id'])
    assert.equal(creation.headers['content-type'], 'application/json')
    assert.match(creation.headers['x-request-id'], UUID)
    assert.equal(completions.stream, true)
    // Plus the accept the page's own completions call sends where its other XHRs carry axios's default.
    assert.deepEqual(Object.keys(completions.headers).sort(), ['accept', 'content-type', 'x-request-id'])
    assert.equal(completions.headers['content-type'], 'application/json')
    assert.equal(completions.headers.accept, 'application/json')
    assert.match(completions.headers['x-request-id'], UUID)
    // The Bearer is the page's, the worker's to send: it is not the app's to bring.
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
})

/* ------------------ whole-answer calls to any address of the origin (Qwen2API-03v) -- */

// The JSON calls of images/video and of file upload — chat info, video task
// status, STS token, file parse — behind the flag of chats/new (enabled()).
const CHAT_INFO = 'https://chat.qwen.ai/api/v2/chats/chat-1'
const TASK_STATUS = 'https://chat.qwen.ai/api/v1/tasks/status/task-1'
const STS_TOKEN = 'https://chat.qwen.ai/api/v1/files/getstsToken'
const CHAT = { success: true, data: { chat: { id: 'chat-1' } } }
// What qwen.ai answers a file's parse with, and what it is asked for.
const STS = {
    access_key_id: 'test-access-key', access_key_secret: 'test-access-secret', security_token: 'test-security-token',
    file_url: 'https://example.invalid/upload.txt', file_path: 'test/upload.txt', bucketname: 'upload-proxy-test',
    region: 'oss-cn-hangzhou', file_id: 'upload-proxy-file'
}
const STS_ASK = { filename: 'upload.txt', filesize: 14, filetype: 'document' }
// A JSON call's answer as the test scripts it: qwen.ai's status and body inside.
const json = (payload, status = 200) => egress(payload, [], status)
const punish = () => json({ ret: ['FAIL_SYS_USER_VALIDATE'], data: { url: `https://chat.qwen.ai/punish?${SECRET}` } })
// The page's answer to a whole-answer call: one reply for every call, or as
// many as the array holds (its last one then, for every call after).
const pageAnswering = replies => {
    worker.script.egress = () => (typeof replies === 'function' ? replies() : Array.isArray(replies) ? (replies.length > 1 ? replies.shift() : replies[0]) : replies)
}
// What a failed whole-answer call is to the client, for the callers that
// answer ChatCreationError by code: the category, the status, and the fixed
// message — never a body, a cause or a worker's detail.
const callRefused = (code, status) => error => {
    assert.ok(error instanceof browserEgress.EgressCallError, `an EgressCallError, not ${error?.name}`)
    assert.ok(error instanceof ChatCreationError)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    assert.equal(error.response, undefined)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET))
    return true
}

test('egressJson: a GET leaves from the page, on the page\'s own session, and comes back in axios\' shape', async () => {
    const account = givenAccount()
    pageAnswering(() => egress(CHAT, [cookie('cna', 'from-page')]))

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.deepEqual(response, {
        status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, data: CHAT
    })
    // The jar the page holds now is the session's.
    assert.equal(jarPairs(CHAT_INFO).cna, 'from-page')

    assert.deepEqual(direct, [], 'no axios call reaches qwen.ai')
    const [call] = worker.sent('/egress')
    assert.equal(call.url, CHAT_INFO)
    assert.equal(call.method, 'GET')
    assert.equal(call.body, undefined, 'nothing to carry')
    assert.equal(call.proxy, null)
    assert.equal(call.timeoutMs, browserEgress.JSON_TIMEOUT_MS)
    assert.equal(call.stream, undefined, 'a whole-answer call: the page makes it an XMLHttpRequest, as chats/new')
    // A call without a body states no content-type. No Bearer either: the page's token is its own (Qwen2API-jr9).
    assert.deepEqual(Object.keys(call.headers), ['x-request-id'])
    assert.match(call.headers['x-request-id'], /^[0-9a-f-]{36}$/)
    assert.deepEqual(logs, [])
})

test('egressJson: a POST carries its body as text, with content-type, and no Bearer', async () => {
    const account = givenAccount()
    pageAnswering(json({ success: true, data: {} }))

    const response = await browserEgress.egressJson({
        account, url: STS_TOKEN, method: 'POST', body: JSON.stringify(STS_ASK), timeoutMs: 25000
    })
    assert.deepEqual(response.data, { success: true, data: {} })
    const [call] = worker.sent('/egress')
    assert.equal(call.method, 'POST')
    assert.equal(call.timeoutMs, 25000, 'the caller\'s budget where it brings one')
    assert.deepEqual(JSON.parse(call.body), STS_ASK)
    assert.deepEqual(Object.keys(call.headers).sort(), ['content-type', 'x-request-id'])
    assert.equal(call.headers['content-type'], 'application/json')
    assert.equal(bringsBearer(call), false)
    assert.deepEqual(direct, [])
})

test('egressJson: an answer that is no JSON comes back as its text', async () => {
    const account = givenAccount()
    // A page, but no challenge: nothing to recover from, and the caller's to read.
    const maintenance = '<!doctype html><html><title>Maintenance</title></html>'
    pageAnswering(() => egress(maintenance))

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.equal(response.status, 200)
    assert.equal(response.data, maintenance)
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('egressJson: a session refused is recovered inside the call — live reload, then exactly one retry', async () => {
    const account = givenAccount()
    pageAnswering([unauthorized(), egress(CHAT)])
    worker.script.renew = body => sessionOnPage(body, harvested('renewed'))

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    assert.deepEqual(worker.sent('/renew')[0], { email: EMAIL, proxy: null, force: true })
    // The retry rides the page's session, not a token of the store's.
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
    assert.equal(current().token, tokenWith('renewed'))
})

test('egressJson: refused again after the reload — one retry, then the failure as chats/new names it, and no password', async () => {
    const account = givenAccount()
    pageAnswering(() => unauthorized())

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }),
        callRefused('upstream_session_unauthorized', 502))
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    // Not now, and not once the reload's bookkeeping has settled: this call
    // escalates to nothing — chats/new accepted the session for its request.
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
    // The reload did what it does — the session is the one it published — and qwen.ai refused that one too.
    assert.equal(current().token, tokenWith('renewed'))
})

test('egressJson: an HTTP 401 is the refused session too', async () => {
    const account = givenAccount()
    pageAnswering(() => json('', 401))

    await assert.rejects(browserEgress.egressJson({ account, url: TASK_STATUS }),
        callRefused('upstream_session_unauthorized', 502))
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
})

test('egressJson: a dead profile is re-logged in with the password before the retry', async () => {
    const account = givenAccount()
    // The page cannot be opened, and the reload finds it logged out.
    worker.script.renew = () => refused(422, 'session_expired')
    pageAnswering([refused(404, 'no_profile'), egress(CHAT)])

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/session', '/egress'])
    assert.equal(worker.sent('/session')[0].force, true)
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
})

test('egressJson: a WAF challenge page gets the live reload and exactly one retry', async () => {
    const account = givenAccount()
    pageAnswering([challenged(), egress(CHAT)])
    worker.script.renew = body => sessionOnPage(body, harvested('renewed'))

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    // A challenge is not the session's doing: a reload, and never a password.
    assert.equal(worker.count('/session'), 0)
})

test('egressJson: the punish envelope under status 200 is a challenge too', async () => {
    const account = givenAccount()
    pageAnswering([punish(), egress(CHAT)])

    const response = await browserEgress.egressJson({ account, url: TASK_STATUS })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
})

test('egressJson: a challenge that outlasts the reload is the 503 of chats/new — and never costs a password', async () => {
    const account = givenAccount()
    pageAnswering(() => challenged())

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), error => {
        callRefused('upstream_waf_challenge', 503)(error)
        // The wait every chat challenge is answered with: the client's Retry-After.
        assert.equal(error.retryAfter, 30)
        return true
    })
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('egressJson: a challenge page served as an HTTP 401 is a challenge — read before the session, so that it never costs a password', async () => {
    const account = givenAccount()
    const page = `<html><head><meta name="aliyun_waf_aa" content="${SECRET}"></head></html>`
    pageAnswering(() => ok({
        status: 401, headers: { 'content-type': 'text/html' }, body: page, url: CHAT_INFO, redirected: false, cookies: []
    }))
    // The page cannot be reloaded. For a refused SESSION that is the password's moment; for a challenge it never is.
    worker.script.renew = () => refused(404, 'no_profile')

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), callRefused('upstream_waf_challenge', 503))
    // One call, the reload, and — the profile being gone — nothing more: no retry, no password.
    assert.deepEqual(worker.routes(), ['/egress', '/renew'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('egressJson: a non-2xx of qwen.ai is rejected as axios rejects one, and recovers nothing', async () => {
    const account = givenAccount()
    const session = current()
    const body = JSON.stringify({ success: false, data: { code: 'Forbidden', details: SECRET } })
    pageAnswering(() => ok({
        status: 403, headers: { 'content-type': 'application/json' }, body, url: TASK_STATUS, redirected: false, cookies: []
    }))

    await assert.rejects(browserEgress.egressJson({ account, url: TASK_STATUS }), error => {
        assert.equal(error.isAxiosError, true)
        assert.equal(error.message, 'Request failed with status code 403')
        assert.equal(error.code, 'ERR_BAD_REQUEST')
        assert.equal(error.response.status, 403)
        assert.equal(error.response.statusText, 'Forbidden')
        // The body as the direct path gets it with responseType json: the caller classifies it.
        assert.deepEqual(error.response.data, { success: false, data: { code: 'Forbidden', details: SECRET } })
        return true
    })
    // A status of qwen.ai's is the caller's to classify: no reload, no retry, no direct request.
    assert.deepEqual(worker.routes(), ['/egress'])
    assert.equal(current(), session)
    assert.deepEqual(direct, [])
})

test('egressJson: a 429 keeps its Retry-After, as the direct transports hand it on', async () => {
    const account = givenAccount()
    pageAnswering(() => ok({
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' },
        body: '{"success":false,"data":{"code":"RateLimited","num":5}}', url: STS_TOKEN, redirected: false, cookies: []
    }))

    await assert.rejects(browserEgress.egressJson({ account, url: STS_TOKEN, method: 'POST', body: '{}' }), error => {
        assert.equal(error.response.status, 429)
        assert.equal(error.response.headers['retry-after'], '7')
        assert.deepEqual(error.response.data, { success: false, data: { code: 'RateLimited', num: 5 } })
        return true
    })
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('egressJson: a worker that cannot carry the call is a retryable 503 with the worker\'s code — never an empty answer, never a direct request', async () => {
    const account = givenAccount()
    const session = current()
    for (const [status, code] of [
        [502, 'page_closed'], [502, 'page_fault'], [502, 'egress_too_large'], [503, 'resident_capacity'], [504, 'egress_timeout']
    ]) {
        worker.calls.length = 0
        logs.length = 0
        pageAnswering(refused(status, code))

        await assert.rejects(browserEgress.egressJson({ account, url: TASK_STATUS }), error => {
            callRefused('upstream_transport_error', 503)(error)
            assert.equal(error.workerCode, code)
            assert.equal(error.message, 'Qwen upstream call failed in the signin worker')
            return true
        }, code)
        // Nothing in the page is wrong with it: no reload, no password, and no retry of the worker's.
        assert.deepEqual(worker.routes(), ['/egress'], code)
        assert.ok(logs.some(args => String(args[0]).includes(code) && String(args[0]).includes('/api/v1/tasks/status/task-1')),
            `${code}: the log names the call and the worker's code`)
        assert.deepEqual(direct, [], code)
    }
    assert.equal(current(), session)
})

test('egressJson: a worker that cannot be reached at all is the same 503', async () => {
    const account = givenAccount()
    const unreachable = config.signinWorkerUrl
    config.signinWorkerUrl = 'http://127.0.0.1:1'

    try {
        await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), callRefused('upstream_transport_error', 503))
    } finally {
        config.signinWorkerUrl = unreachable
    }
    assert.deepEqual(direct, [])
})

test('egressJson: an answer out of shape is the egress\'s failure, not an answer', async () => {
    const account = givenAccount()
    // An old worker, say, answering something else under its 200.
    pageAnswering(ok({ status: 200, headers: {} }))

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), callRefused('upstream_transport_error', 503))
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('egressJson: a target off the chat origin is refused before the worker hears about it', async () => {
    const account = givenAccount()

    await assert.rejects(browserEgress.egressJson({ account, url: 'https://files.stand.test/api/v2/chats/chat-1' }),
        callRefused('upstream_transport_error', 503))
    assert.equal(worker.calls.length, 0)
    assert.deepEqual(direct, [])
})

test('egressJson: one recovery per interval — a refusal inside the window fails as it is, with no second reload', async () => {
    config.sessionRecoveryMinIntervalMs = 60000
    const account = givenAccount()
    pageAnswering(() => unauthorized())

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), callRefused('upstream_session_unauthorized', 502))
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)

    await assert.rejects(browserEgress.egressJson({ account, url: CHAT_INFO }), callRefused('upstream_session_unauthorized', 502))
    // A refusal that got no recovery schedules nothing of its own behind the
    // request either — no reload, and no password: a call escalates to nothing.
    await until(() => sessionPersistence.renewals.size === 0)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress', '/egress'])
    assert.equal(worker.count('/session'), 0)
})

test('egressJson: a refusal that lands after a sibling replaced the session retries after that recovery, with no reload of its own', async () => {
    const account = givenAccount()
    const sibling = harvested('sibling')
    pageAnswering(() => {
        // The store moved on while this call was on its way out.
        if (current().token !== sibling.token) {
            store.setSession(EMAIL, { token: sibling.token, expiresAt: EXPIRES_AT, jar: store.jarFromCookies(sibling.cookies) })
            return unauthorized()
        }
        return egress(CHAT)
    })

    const response = await browserEgress.egressJson({ account, url: CHAT_INFO })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
})

test('egressJson: with no session left in the store the call still goes out, on the page\'s session', async () => {
    const account = givenAccount()
    store.clearSessions()
    pageAnswering(() => egress(CHAT))

    const response = await browserEgress.egressJson({ account, url: TASK_STATUS })
    assert.deepEqual(response.data, CHAT)
    assert.deepEqual(worker.routes(), ['/egress'])
    assert.equal(worker.count('/renew'), 0)
})

test('egressJson: with no account to name, the worker\'s dead profile is the refused session — and nothing can recover it', async () => {
    // No account at all: the worker refuses the call before any page is touched.
    pageAnswering(refused(404, 'no_profile'))

    await assert.rejects(browserEgress.egressJson({ url: TASK_STATUS }), callRefused('upstream_session_unauthorized', 502))
    // There is no account to reload one for.
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('callFailure: what a failed egress call is to the client, and what is left to the caller', () => {
    const { SigninError } = require('../src/utils/signin-error')
    const transport = { status: 503, error: 'Qwen upstream call failed in the signin worker', code: 'upstream_transport_error' }
    const unauthorized = { status: 502, error: 'Qwen session authorization rejected; this is not Qwen2API client authentication', code: 'upstream_session_unauthorized' }
    // The relay's own failures carry the worker's code.
    assert.deepEqual(browserEgress.callFailure(Object.assign(new Error(`signin-worker egress: page_closed ${SECRET}`), { code: 'ECONNRESET', workerCode: 'page_closed' })), transport)
    // A worker refusing the call itself.
    assert.deepEqual(browserEgress.callFailure(new SigninError('signin_transport_error', 502, SECRET)), transport)
    assert.deepEqual(browserEgress.callFailure(new SigninError('signin_upstream_error', 502, SECRET, 400)), transport)
    // A session qwen.ai refused twice, as postCompletions rejects it.
    assert.deepEqual(browserEgress.callFailure(Object.assign(new Error(SECRET), {
        isAxiosError: true, code: 'ERR_BAD_REQUEST', response: { status: 401, data: SECRET }
    })), unauthorized)
    // Any other status of qwen.ai's is the caller's to classify, and so is anything else.
    assert.equal(browserEgress.callFailure(Object.assign(new Error(SECRET), { isAxiosError: true, response: { status: 429 } })), null)
    assert.equal(browserEgress.callFailure(Object.assign(new Error(SECRET), { isAxiosError: true, response: { status: 503 } })), null)
    assert.equal(browserEgress.callFailure(Object.assign(new Error(SECRET), { response: { status: 401 } })), null)
    assert.equal(browserEgress.callFailure(new Error(SECRET)), null)
    assert.equal(browserEgress.callFailure(null), null)
})

/* -------------------- images/video: the generation call and its polls (Qwen2API-03v) -- */

const {
    handleImageVideoCompletion, handleOpenAIImagesGeneration, handleOpenAIVideoGeneration,
    getChatDetail, getVideoTaskStatus
} = require('../src/controllers/chat.image.video')
const { setChatChallengeClockForTests } = require('../src/utils/upstream-error')

const IMAGE_URL = 'https://cdn.example.com/a.png'
const VIDEO_URL = 'https://cdn.example.com/v.mp4'
const TASK_STATUS_URL = 'https://chat.qwen.ai/api/v1/tasks/status/task-1'
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000
const T2I = { stream: false, chat_type: 't2i', model: MODEL, messages: [{ role: 'user', content: 'a cat' }] }
const T2V = { ...T2I, chat_type: 't2v' }
const TRANSPORT_FAILURE = { error: 'Qwen upstream call failed in the signin worker', code: 'upstream_transport_error' }
// The Bearer a direct call carries, whatever the case of its header's name.
const bearerOf = call => Object.entries(call.headers || {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]

// The media controller picks its account itself: hand it the test's.
async function withAccount(account, fn) {
    const real = accountManager.getAccount
    accountManager.getAccount = () => account
    try {
        return await fn()
    } finally {
        accountManager.getAccount = real
    }
}

// An Express response, as the controllers write one.
const response = () => ({
    headers: {}, headersSent: false, writableEnded: false, statusCode: 200, output: '',
    set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this },
    status(value) { this.statusCode = value; return this },
    json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this },
    write(chunk) { this.headersSent = true; this.output += chunk; return true },
    end(chunk = '') { this.output += chunk; this.writableEnded = true },
    on() { return this }
})

// An image's answer from the relay: SSE, one frame carrying the picture's link.
const picture = (url = IMAGE_URL) => {
    const stream = relay()
    stream.head()
    stream.chunk(frame({ choices: [{ delta: { phase: 'image_gen', content: `![image](${url})` } }] }))
    stream.end()
    return stream
}
// A video's answer from the relay: the JSON the direct path had Axios parse — a task to poll.
const task = () => {
    const stream = relay()
    stream.head(200, { 'content-type': 'application/json' })
    stream.chunk(JSON.stringify({ success: true, data: { task_id: 'task-1' } }))
    stream.end()
    return stream
}
// The task's status: done, with the video.
const done = () => json({ task_status: 'success', content: VIDEO_URL })
// A relay the worker ends with a failure of its own, before qwen.ai answered.
const broken = code => {
    const stream = relay()
    stream.fail(code)
    return stream
}
// The chat, as its detail comes back with the picture in its history.
const withPictureInHistory = () => egress({
    success: true,
    data: { chat: { history: { messages: {
        m1: { response_id: 'r1', content: [{ type: 'image', image: { url: IMAGE_URL } }] }
    } } } }
})

// qwen.ai behind the page as the stand-in answers it: chats/new, the chat and
// the task's status as whole answers, and the generation as a relay — one per
// call, each taken from `generations` in its turn.
function qwenBehindThePage({ generations = [], chatDetail, taskStatus = done }) {
    worker.script.egress = body => {
        if (body.stream === true) {
            assert.ok(generations.length, 'more generation calls than the script has relays for')
            return generations.shift().open
        }
        const pathname = new URL(body.url).pathname
        if (pathname === '/api/v2/chats/new') return egress(chat('chat-1'))
        if (pathname === '/api/v2/chats/chat-1') return chatDetail()
        // The status of the task named in the address.
        if (pathname.startsWith('/api/v1/tasks/status/')) return taskStatus(pathname.slice('/api/v1/tasks/status/'.length))
        throw new Error(`nothing on the page answers ${pathname}`)
    }
}
const generations = () => worker.sent('/egress').filter(body => body.stream === true)
const polls = () => worker.sent('/egress').filter(body => body.url === TASK_STATUS_URL)

// Both flags as prod has them since 2026-11-25. A video's answer is JSON with
// no frame in it: nothing holds it back for the first-frame grace.
function throughThePage() {
    config.completionsTransport = 'browser'
    browserEgress.setTimingForTests({ firstFrameMs: 20 })
}

test('Qwen2API-03v: an image is generated from the page — the completions call is the page\'s own fetch, and nothing of axios is sent', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [picture()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)

    // chats/new, whole as ever; the generation, relayed.
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(direct, [])
    const [creation, generation] = worker.sent('/egress')
    assert.equal(creation.stream, undefined)
    // The one address qwen.ai takes from a fetch alone (Qwen2API-3ue.9): never a whole-answer XMLHttpRequest.
    assert.equal(generation.stream, true)
    assert.equal(generation.url, `${COMPLETIONS}chat-1`)
    assert.equal(generation.method, 'POST')
    assert.equal(generation.timeoutMs, GENERATION_TIMEOUT_MS)
    assert.deepEqual(Object.keys(generation.headers).sort(), ['accept', 'content-type', 'x-request-id'])
    assert.equal(generation.headers.accept, 'application/json')
    // The body the direct path built, unchanged.
    assert.deepEqual(JSON.parse(generation.body), {
        stream: true, version: '2.1', incremental_output: true, chat_id: 'chat-1', model: MODEL,
        messages: [{ role: 'user', content: 'a cat', files: [], chat_type: 't2i', feature_config: { output_schema: 'phase' } }]
    })
    // Not the app's Bearer on either (Qwen2API-jr9).
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false])
})

test('Qwen2API-03v: a video is generated from the page — the relayed answer read whole, the task polled through the page', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [task()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))

    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'])
    assert.deepEqual(direct, [])
    const [creation, generation, poll] = worker.sent('/egress')
    assert.deepEqual([creation.stream, generation.stream, poll.stream], [undefined, true, undefined])
    assert.equal(generation.url, `${COMPLETIONS}chat-1`)
    // The video's body asks for no stream; the call is the page's fetch all the same.
    assert.equal(JSON.parse(generation.body).stream, false)
    assert.equal(JSON.parse(generation.body).messages[0].chat_type, 't2v')
    // The poll is a whole-answer call, as chats/new is one.
    assert.equal(poll.url, TASK_STATUS_URL)
    assert.equal(poll.method, 'GET')
    assert.equal(poll.body, undefined)
    assert.deepEqual(Object.keys(poll.headers), ['x-request-id'])
    assert.equal(poll.timeoutMs, browserEgress.JSON_TIMEOUT_MS)
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false])
})

test('Qwen2API-03v: an image whose link is not in the answer is looked up in the chat — through the page', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [picture('')], chatDetail: withPictureInHistory })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)

    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress'])
    const [lookup] = worker.sent('/egress').filter(body => body.url === CHAT_INFO)
    assert.equal(lookup.method, 'GET')
    assert.equal(lookup.body, undefined)
    assert.deepEqual(Object.keys(lookup.headers), ['x-request-id'])
    assert.equal(bringsBearer(lookup), false)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a transient internal error from the page is retried once, as it was from axios', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    const internal = () => {
        const stream = relay()
        stream.head(200, { 'content-type': 'application/json' })
        stream.chunk(JSON.stringify({ success: false, data: { code: 'Bad_Request', details: 'internal error' }, request_id: 'req-1' }))
        stream.end()
        return stream
    }
    qwenBehindThePage({ generations: [internal(), task()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress'])
    assert.equal(generations().length, 2, 'the one retry the direct path gives an internal error')
})

test('Qwen2API-03v: a WAF challenge page on the generation gets the live reload and exactly one retry', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [challenging(), picture()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    assert.equal(worker.count('/session'), 0, 'a reload is all a challenge is worth')
})

test('Qwen2API-03v: a challenge that outlasts the reload is one retryable 503 — never an image, never a password', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [challenging(), challenging()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 503)
    assert.ok(Number(res.headers['Retry-After']) > 0)
    assert.equal(res.body.code, 'upstream_waf_challenge')
    // Not the challenge page's own picture, passed off as the generation.
    assert.doesNotMatch(JSON.stringify(res.body), /cdn\.example|alicdn|punish/)
    assert.equal(res.body.choices, undefined)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a session refused in the generation is recovered with one reload and one retry', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [refusing(), picture()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
})

test('Qwen2API-03v: refused again after the reload — the 502 with its code, and no password', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [refusing(), refusing()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 502)
    assert.deepEqual(res.body, {
        error: 'Qwen session authorization rejected; this is not Qwen2API client authentication',
        code: 'upstream_session_unauthorized'
    })
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('Qwen2API-03v: a worker that cannot carry the generation is one retryable 503 — not a 500 with the relay\'s words in it', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    for (const code of ['page_closed', 'page_fault', 'egress_timeout', 'relay_malformed']) {
        worker.calls.length = 0
        qwenBehindThePage({ generations: [broken(code), broken(code)] })

        const res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
        assert.equal(res.statusCode, 503, code)
        assert.deepEqual(res.body, TRANSPORT_FAILURE, code)
        assert.doesNotMatch(JSON.stringify(res.body), /signin-worker egress/, code)
        // The controller's one retry is for an internal error of qwen.ai's, not for this.
        assert.equal(generations().length, 1, code)
        assert.equal(worker.count('/renew'), 0, code)
        assert.ok(JSON.stringify(logs).includes(code), `${code}: the log names the worker's code`)
        assert.deepEqual(direct, [], code)
    }
    // A worker that is not there at all is the same failure.
    qwenBehindThePage({ generations: [picture()] })
    const unreachable = config.signinWorkerUrl
    config.signinWorkerUrl = 'http://127.0.0.1:1'
    try {
        const res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
        assert.equal(res.statusCode, 503)
        assert.deepEqual(res.body, {
            error: 'Qwen chat creation transport failed', code: 'upstream_transport_error'
        })
    } finally {
        config.signinWorkerUrl = unreachable
    }
})

test('Qwen2API-03v: a 429 on the generation is the quota, with its wait, as it was from axios', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    const limited = () => {
        const stream = relay()
        stream.head(429, { 'content-type': 'application/json', 'retry-after': '18000' })
        stream.chunk(JSON.stringify({ success: false, data: { code: 'RateLimited', num: 5 } }))
        stream.end()
        return stream
    }
    qwenBehindThePage({ generations: [limited()] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 429)
    assert.equal(res.body.code, 'RateLimited')
    assert.equal(res.body.wait_hours, 5)
    assert.equal(generations().length, 1)
})

test('Qwen2API-03v: a poll of the video task the worker cannot carry ends the wait at once — it is not polled on as "not done"', { timeout: 15000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [task()], taskStatus: () => refused(502, 'page_closed') })

    const started = Date.now()
    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    // Not the sixty polls, twenty seconds apart, that the task is given.
    assert.ok(Date.now() - started < 10000)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    assert.equal(polls().length, 1, 'one poll, and it was the last')
    assert.equal(worker.count('/renew'), 0, 'nothing in the page is wrong with it')
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: the task\'s status refused as unauthorized is recovered with one reload and one retry, and polled on', { timeout: 15000 }, async () => {
    throughThePage()
    const account = givenAccount()
    const statuses = [unauthorized(), done()]
    qwenBehindThePage({ generations: [task()], taskStatus: () => statuses.shift() })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/renew', '/egress'])
    assert.deepEqual(polls().map(bringsBearer), [false, false])
})

test('Qwen2API-03v: the task\'s status challenged twice is the 503 of the challenge — and no polling on, no password', { timeout: 15000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [task()], taskStatus: () => challenged() })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, {
        error: 'Qwen requires WAF/CAPTCHA verification', code: 'upstream_waf_challenge', retry_after: 30
    })
    assert.equal(res.headers['Retry-After'], '30', 'the wait every chat challenge is answered with')
    assert.equal(polls().length, 2, 'the poll and its one retry')
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('Qwen2API-03v: a video whose task is in the chat, not in the answer, is found through the page', { timeout: 15000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({
        generations: [picture('')],
        chatDetail: () => egress({ success: true, data: { chat: { history: { messages: { m1: { response_id: 'r1', task_id: 'task-1' } } } } } })
    })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress'])
})

test('Qwen2API-03v: the OpenAI image and video endpoints generate through the page too', { timeout: 15000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [picture()] })
    const image = response()
    await withAccount(account, () => handleOpenAIImagesGeneration({ body: { model: MODEL, prompt: 'a cat' } }, image))
    assert.equal(image.statusCode, 200)
    assert.deepEqual(image.body.data, [{ url: IMAGE_URL }])

    qwenBehindThePage({ generations: [task()] })
    const video = response()
    await withAccount(account, () => handleOpenAIVideoGeneration({ body: { model: MODEL, prompt: 'a cat' } }, video))
    assert.equal(video.statusCode, 200)
    assert.deepEqual(video.body.data, [{ url: VIDEO_URL }])
    assert.deepEqual(direct, [])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), worker.sent('/egress').map(() => false))
})

test('Qwen2API-03v: with the transports off, images and video stay on axios — the direct call is not touched', { timeout: 10000 }, async () => {
    config.chatCreationTransport = 'direct'
    config.completionsTransport = 'auto'
    const account = givenAccount()
    const directCalls = []
    const realGet = axios.get
    axios.get = async (url, requestConfig) => {
        directCalls.push({ how: 'GET', url, requestConfig })
        return { data: { task_status: 'success', content: VIDEO_URL } }
    }
    directReply = async (url, data, requestConfig) => {
        if (url.endsWith('/chats/new')) return { status: 200, data: chat('direct-chat'), headers: {} }
        directCalls.push({ how: 'POST', url, data, requestConfig })
        return requestConfig.responseType === 'json'
            ? { status: 200, data: { success: true, data: { task_id: 'task-1' } }, headers: {} }
            : { status: 200, data: Readable.from([Buffer.from(frame({ choices: [{ delta: { phase: 'image_gen', content: `![image](${IMAGE_URL})` } }] }))]), headers: {} }
    }

    try {
        const image = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, image))
        assert.equal(image.statusCode, 200)
        assert.equal(image.body.choices[0].message.content, `![image](${IMAGE_URL})`)

        const video = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, video))
        assert.equal(video.statusCode, 200)
        assert.ok(video.body.choices[0].message.content.includes(VIDEO_URL))
    } finally {
        axios.get = realGet
    }
    assert.equal(worker.calls.length, 0, 'the worker is not involved')
    const posts = directCalls.filter(call => call.how === 'POST')
    // chats/new and each generation, in their turn.
    assert.deepEqual(direct.map(call => new URL(call.url).pathname), [
        '/api/v2/chats/new', '/api/v2/chat/completions', '/api/v2/chats/new', '/api/v2/chat/completions'
    ])
    // The direct generation calls, built as they were before the egress: on the
    // app's Bearer, each with its own response type, the same budget.
    const [imageCall, videoCall] = posts.filter(call => call.url.endsWith('chat_id=direct-chat'))
    assert.equal(new URL(imageCall.url).search, '?chat_id=direct-chat')
    assert.equal(imageCall.requestConfig.responseType, 'stream', 'an image: read as a stream')
    assert.equal(videoCall.requestConfig.responseType, 'json', 'a video: parsed by axios')
    assert.deepEqual([imageCall, videoCall].map(call => call.requestConfig.timeout), [GENERATION_TIMEOUT_MS, GENERATION_TIMEOUT_MS])
    assert.deepEqual([imageCall, videoCall].map(call => bearerOf({ headers: call.requestConfig.headers })),
        [`Bearer ${account.token}`, `Bearer ${account.token}`])
    assert.equal(videoCall.requestConfig.headers['bx-v'], '2.5.36')
    // The direct poll: axios, on the app's Bearer.
    const [poll] = directCalls.filter(call => call.how === 'GET')
    assert.equal(poll.url, TASK_STATUS_URL)
    assert.equal(bearerOf({ headers: poll.requestConfig.headers }), `Bearer ${account.token}`)
})

test('Qwen2API-03v: each call follows its own flag — with chats/new direct, the generation goes from the page and the polls stay on axios', { timeout: 10000 }, async () => {
    throughThePage()
    config.chatCreationTransport = 'direct'
    // The account has a proxy of its own: that the direct poll found the account
    // is known by the poll carrying it.
    const account = { ...givenAccount(), proxy: 'http://127.0.0.1:9' }
    accountManager.accountTokens = [account]
    directReply = async url => (url.endsWith('/chats/new')
        ? { status: 200, data: chat('chat-1'), headers: {} }
        : assert.fail(`no direct completions: ${url}`))
    const realGet = axios.get
    const polled = []
    axios.get = async (url, requestConfig) => {
        polled.push({ url, proxied: Boolean(requestConfig?.httpsAgent) })
        return { data: { task_status: 'success', content: VIDEO_URL } }
    }

    try {
        // The page's session is refused once: the reload rotates the token before the task is named.
        qwenBehindThePage({
            generations: [refusing(), task()],
            taskStatus: () => assert.fail('the poll does not go through the page')
        })
        const res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
        assert.equal(res.statusCode, 200)
        assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    } finally {
        axios.get = realGet
    }
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'], 'the generation alone, with its recovery')
    // The poll follows the token the store holds now — the renewed one — so it
    // finds the account, and the account's proxy (Qwen2API-3ue.3, as in request.js).
    assert.equal(account.token, tokenWith('renewed'))
    assert.deepEqual(polled, [{ url: TASK_STATUS_URL, proxied: true }])
})

test('Qwen2API-03v: the chat breaker counts what the page answered, on the account\'s egress — and an answered image closes its probe', { timeout: 20000 }, async () => {
    throughThePage()
    const account = givenAccount()
    let now = Date.now()
    setChatChallengeClockForTests(() => now)
    const generate = async () => {
        const res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
        return res
    }
    const challengedEveryTime = () => qwenBehindThePage({ generations: [challenging(), challenging()] })

    try {
        // Three challenged requests open the breaker: one strike each.
        for (let i = 1; i <= 3; i++) {
            challengedEveryTime()
            worker.calls.length = 0
            assert.equal((await generate()).statusCode, 503, `request ${i}`)
            assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'], `request ${i}: one challenge, one strike`)
        }
        // Open: nothing reaches the page.
        challengedEveryTime()
        worker.calls.length = 0
        const held = await generate()
        assert.equal(held.statusCode, 503)
        assert.equal(held.body.code, 'upstream_waf_challenge')
        assert.deepEqual(worker.routes(), [])

        // Cooled down: the first request through is the one probe, and qwen.ai's answer closes the breaker.
        now += 60_000
        worker.calls.length = 0
        qwenBehindThePage({ generations: [picture()] })
        const probe = await generate()
        assert.equal(probe.statusCode, 200)
        assert.deepEqual(worker.routes(), ['/egress', '/egress'])

        // Closed again: the next request is none of the breaker's business, a challenge included.
        challengedEveryTime()
        worker.calls.length = 0
        const answered = await generate()
        assert.equal(answered.statusCode, 503)
        assert.equal(answered.body.code, 'upstream_waf_challenge')
        assert.deepEqual(worker.routes(), ['/egress', '/egress', '/renew', '/egress'])
    } finally {
        setChatChallengeClockForTests(() => Date.now())
    }
})

test('Qwen2API-03v: a failed generation leaves the next probe available', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    let now = Date.now()
    setChatChallengeClockForTests(() => now)
    try {
        // Three challenges open the breaker, and the cooldown ends.
        for (let i = 0; i < 3; i++) {
            qwenBehindThePage({ generations: [challenging(), challenging()] })
            await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, response()))
        }
        now += 60_000
        // The probe is the request that follows — and the worker cannot carry it.
        qwenBehindThePage({ generations: [broken('page_closed')] })
        const failed = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, failed))
        assert.equal(failed.statusCode, 503)
        assert.equal(failed.body.code, 'upstream_transport_error')
        // So the breaker does not stay armed on a probe that never got its answer.
        // Inside the window that probe armed, the next request must go through.
        now += 30_000
        qwenBehindThePage({ generations: [picture()] })
        const next = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, next))
        assert.equal(next.statusCode, 200)
    } finally {
        setChatChallengeClockForTests(() => Date.now())
    }
})

test('Qwen2API-03v: a streaming client gets a failed generation as its status — never a 200 with the failure for its picture', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    const T2V_STREAMED = { ...T2V, stream: true }
    // Nothing of the stream was written yet: the status is still the client's to get.
    for (const [body, relays, code, status] of [
        [T2I, [broken('page_closed')], 'upstream_transport_error', 503],
        [T2V_STREAMED, [broken('page_closed')], 'upstream_transport_error', 503],
        [T2I, [refusing(), refusing()], 'upstream_session_unauthorized', 502],
        [T2V_STREAMED, [refusing(), refusing()], 'upstream_session_unauthorized', 502]
    ]) {
        worker.calls.length = 0
        qwenBehindThePage({ generations: relays })
        const res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body }, res))
        assert.equal(res.statusCode, status, code)
        assert.equal(res.body.code, code)
        assert.equal(res.headers['Content-Type'], 'application/json', code)
        assert.equal(res.output, '', `${code}: no SSE was written`)
        assert.equal(res.body.choices, undefined, `${code}: the failure is not an answer`)
    }

    // A video's keep-alive may have committed the stream already: the status is
    // spent, and the failure travels in the stream, as an error.
    qwenBehindThePage({ generations: [broken('page_closed')] })
    const committed = response()
    committed.headersSent = true
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V_STREAMED }, committed))
    const frame = committed.output.split('\n').find(line => line.startsWith('data: {'))
    assert.deepEqual(JSON.parse(frame.slice(6)).error, {
        message: TRANSPORT_FAILURE.error, code: 'upstream_transport_error', type: 'server_error'
    })
    assert.ok(committed.output.endsWith('data: [DONE]\n\n'))
    assert.doesNotMatch(committed.output, /choices/, 'the failure is not passed off as an answer')
})

test('Qwen2API-03v: an image edit is generated from the page too — with its picture in the body, as the direct path sends it', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [picture('https://cdn.example.com/edited.png')] })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: { ...T2I, chat_type: 'image_edit', messages: [{
        role: 'user', content: [{ type: 'text', text: 'a cat, in red' }, { type: 'image', image: IMAGE_URL }]
    }] } }, res))
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, '![image](https://cdn.example.com/edited.png)')
    const [generation] = generations()
    assert.equal(generation.stream, true)
    assert.deepEqual(JSON.parse(generation.body).messages[0], {
        role: 'user', content: 'a cat, in red', files: [{ type: 'image', url: IMAGE_URL }],
        chat_type: 'image_edit', feature_config: { output_schema: 'phase' }
    })
})

test('Qwen2API-03v: a relay that fails midway through a video\'s answer is the 503 — half an answer is nobody\'s', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    // The head and a first piece, then the failure: after the first-frame grace,
    // so that the answer was the caller's already.
    const stream = relay()
    stream.head(200, { 'content-type': 'application/json' })
    stream.chunk('{"success":true,"data":{"task_')
    const opened = {
        open: (res, req) => {
            stream.open(res, req)
            setTimeout(() => stream.fail('page_closed'), 80)
        }
    }
    qwenBehindThePage({ generations: [opened], taskStatus: () => assert.fail('no task was named: nothing to poll') })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    assert.deepEqual(worker.routes(), ['/egress', '/egress'])
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a chat lookup the worker cannot carry ends the request at once — it is not looked up five times over', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    qwenBehindThePage({ generations: [picture('')], chatDetail: () => refused(502, 'page_closed') })

    const res = response()
    await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    assert.equal(worker.sent('/egress').filter(call => call.url === CHAT_INFO).length, 1, 'one lookup, and it was the last')
})

test('Qwen2API-03v: the chat lookup and the task poll tell qwen.ai\'s own answers from what the egress could not get answered', async () => {
    const account = givenAccount()
    const token = account.token
    // qwen.ai's own answers, read as they always were: not ready, and nobody's failure.
    for (const [reply, poll, lookup, what] of [
        [() => json({}, 404), null, null, 'an HTTP error'],
        [() => json({ success: false, data: { code: 'Not_Found' } }, 400), null, null, 'a refused answer'],
        [() => json({ task_status: 'running' }), null, { task_status: 'running' }, 'an answer with no task done']
    ]) {
        pageAnswering(reply)
        assert.equal(await getVideoTaskStatus('task-1', token, account), poll, `poll: ${what}`)
        assert.deepEqual(await getChatDetail('chat-1', token, account), lookup, `lookup: ${what}`)
    }
    assert.equal(worker.count('/renew'), 0, 'an answer of qwen.ai\'s recovers nothing')
    pageAnswering(() => json({ task_status: 'success', content: VIDEO_URL }))
    assert.equal(await getVideoTaskStatus('task-1', token, account), VIDEO_URL)
    pageAnswering(() => egress(CHAT))
    assert.deepEqual(await getChatDetail('chat-1', token, account), CHAT)

    // What the egress could not get answered is thrown by both: a worker that
    // could not carry the call; a session refused with its recovery spent; a challenge likewise.
    for (const [reply, code, status, routes] of [
        [() => refused(502, 'page_closed'), 'upstream_transport_error', 503, ['/egress']],
        [() => unauthorized(), 'upstream_session_unauthorized', 502, ['/egress', '/renew', '/egress']],
        [() => challenged(), 'upstream_waf_challenge', 503, ['/egress', '/renew', '/egress']]
    ]) {
        worker.calls.length = 0
        pageAnswering(reply)
        await assert.rejects(getChatDetail('chat-1', token, account), callRefused(code, status))
        assert.deepEqual(worker.routes(), routes, `lookup: ${code}`)
        worker.calls.length = 0
        await assert.rejects(getVideoTaskStatus('task-1', token, account), callRefused(code, status))
        assert.deepEqual(worker.routes(), routes, `poll: ${code}`)
    }
    assert.equal(worker.count('/session'), 0, 'none of it costs a password')
    assert.deepEqual(direct, [])

    // With chats/new direct both are axios', and both swallow as they always did.
    config.chatCreationTransport = 'direct'
    const realGet = axios.get
    axios.get = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
    try {
        assert.equal(await getChatDetail('chat-1', token, account), null)
        assert.equal(await getVideoTaskStatus('task-1', token, account), null)
    } finally {
        axios.get = realGet
    }
})

test('Qwen2API-03v: an error qwen.ai itself gives a poll is "not done", and the poll goes on', { timeout: 15000 }, async t => {
    throughThePage()
    const account = givenAccount()
    // The pause between two polls is the task's own, twenty seconds: the clock is the test's here.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const statuses = [() => json({}, 404), () => done()]
    let polledOnce
    const firstPoll = new Promise(resolve => { polledOnce = resolve })
    try {
        qwenBehindThePage({
            generations: [task()],
            taskStatus: () => {
                const reply = statuses.shift()
                if (statuses.length === 1) polledOnce()
                return reply()
            }
        })
        const res = response()
        const handled = withAccount(account, () => handleImageVideoCompletion({ body: T2V }, res))
        await firstPoll
        // The poll's answer still has to reach the app, and the pause to start:
        // give it the real event loop, then the task's own pause, until the poll that follows.
        for (let i = 0; i < 200 && polls().length < 2; i++) {
            await new Promise(resolve => setImmediate(resolve))
            t.mock.timers.tick(20000)
        }
        await handled
        assert.equal(res.statusCode, 200)
        assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
        assert.equal(polls().length, 2)
        assert.equal(worker.count('/renew'), 0)
    } finally {
        t.mock.timers.reset()
    }
})

/* -------- images/video: qwen.ai silent on a poll is a poll let go by, not the request's end -- */

const SILENT_POLL = 'опрос пропущен'
const GIVEN_UP = 'запрос завершается отказом'
// qwen.ai said nothing for the call's whole budget; the road to it failed.
const silent = () => refused(504, 'egress_timeout')
const failedRoad = () => refused(502, 'egress_failed')
// qwen.ai's own answer: the task is not done. It is an answer all the same.
const running = () => json({ task_status: 'running' })
// The chat, as its detail comes back: with nothing in it yet, with the task in its history,
// with two tasks — a video's answer can name more than one.
const emptyChat = () => egress({ success: true, data: { chat: { history: { messages: {} } } } })
const withTaskInHistory = () => egress({
    success: true,
    data: { chat: { history: { messages: { m1: { task_id: 'task-1' } } } } }
})
const withTwoTasksInHistory = () => egress({
    success: true,
    data: { chat: { history: { messages: { m1: { task_id: 'task-1' }, m2: { task_id: 'task-2' } } } } }
})
const lookups = () => worker.sent('/egress').filter(call => call.url === CHAT_INFO)
const pollsOf = id => worker.sent('/egress').filter(call => call.url === `https://chat.qwen.ai/api/v1/tasks/status/${id}`).length

// What the app warns of while `fn` runs, a line each.
async function withWarnings(fn) {
    const warned = []
    const warn = logger.warn
    logger.warn = (...args) => { warned.push(args.map(String).join(' ')); warn(...args) }
    try {
        await fn()
    } finally {
        logger.warn = warn
    }
    return warned
}
const skippedSaid = () => logs.some(args => String(args[0]).includes(SILENT_POLL))

// A video request to its end with the clock in the test's hand: the task's
// twenty seconds between two polls are ticked off as the app asks for them.
// The clock has to be the test's (t.mock.timers) before this is called.
async function videoToItsEnd(t, { generations: relayed, chatDetail, taskStatus }) {
    qwenBehindThePage({ generations: relayed, chatDetail, taskStatus })
    const res = response()
    const handled = withAccount(givenAccount(), () => handleImageVideoCompletion({ body: T2V }, res))
    for (let i = 0; i < 400 && !res.writableEnded; i++) {
        await new Promise(resolve => setImmediate(resolve))
        t.mock.timers.tick(20000)
    }
    await handled
    return res
}

test('Qwen2API-03v: qwen.ai silent on one poll of the video task — the poll is let go by with a warning, and the next one waits the task\'s own twenty seconds', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const statuses = [silent(), done()]
    let res
    let warned
    try {
        warned = await withWarnings(async () => {
            qwenBehindThePage({ generations: [task()], taskStatus: () => statuses.shift() })
            res = response()
            const handled = withAccount(givenAccount(), () => handleImageVideoCompletion({ body: T2V }, res))
            // The poll was let go by — the app has said so, and asked for its pause.
            for (let i = 0; i < 200 && !skippedSaid(); i++) await new Promise(resolve => setImmediate(resolve))
            assert.equal(polls().length, 1)
            // The pause is the task's own, to the second: not a shorter one for a poll that got no answer.
            t.mock.timers.tick(19999)
            for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve))
            assert.equal(polls().length, 1, 'the next poll waits')
            t.mock.timers.tick(1)
            for (let i = 0; i < 400 && !res.writableEnded; i++) {
                await new Promise(resolve => setImmediate(resolve))
                t.mock.timers.tick(20000)
            }
            await handled
        })

        assert.equal(res.statusCode, 200)
        assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
        assert.equal(polls().length, 2, 'the poll that was let go by, and the one after it')
        // Nothing in the page is wrong with it: no reload, no password, nothing sent from Node.
        // The chats/new, the generation, and the two polls.
        assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress'])
        assert.deepEqual(direct, [])
        assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false, false])
        // Said as what it is — a warning, with the worker's code — and the call's own failure
        // is where it always was, in the log: the seam's line with the worker's code.
        assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 1)
        assert.ok(warned.some(line => line.includes(SILENT_POLL) && line.includes('egress_timeout') && line.includes('1 из 2')))
        assert.equal(warned.filter(line => line.includes(GIVEN_UP)).length, 0)
        assert.ok(logs.some(args => String(args[0]).includes('/api/v1/tasks/status/task-1') && String(args[0]).includes('egress_timeout')))
    } finally {
        t.mock.timers.reset()
    }
})

test('Qwen2API-03v: qwen.ai silent on two polls in a row — both are let go by, and the task is had on the third', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const statuses = [silent(), failedRoad(), done()]
    let res
    let warned
    try {
        warned = await withWarnings(async () => {
            res = await videoToItsEnd(t, { generations: [task()], taskStatus: () => statuses.shift() })
        })
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    assert.equal(polls().length, 3)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress', '/egress'])
    assert.deepEqual(direct, [])
    const skipped = warned.filter(line => line.includes(SILENT_POLL))
    assert.equal(skipped.length, 2)
    assert.ok(skipped[0].includes('egress_timeout') && skipped[0].includes('1 из 2'))
    assert.ok(skipped[1].includes('egress_failed') && skipped[1].includes('2 из 2'))
    assert.equal(warned.filter(line => line.includes(GIVEN_UP)).length, 0)
})

test('Qwen2API-03v: qwen.ai silent on three polls in a row — the request fails with the same 503, on the third poll and no further', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let res
    let warned
    try {
        warned = await withWarnings(async () => {
            res = await videoToItsEnd(t, { generations: [task()], taskStatus: silent })
        })
    } finally {
        t.mock.timers.reset()
    }
    // What a poll the worker could not carry always was to the client.
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    assert.equal(polls().length, 3, 'two let go by, and the third is the last')
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress', '/egress'])
    assert.equal(worker.count('/renew'), 0, 'nothing in the page is wrong with it')
    assert.equal(worker.count('/session'), 0)
    assert.deepEqual(direct, [])
    assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 2)
    assert.ok(warned.some(line => line.includes(GIVEN_UP) && line.includes('egress_timeout')), 'the third is said as the end it is')
})

test('Qwen2API-03v: an answer of qwen.ai\'s between silent polls starts the count over — two, an answer, two, an answer, two', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const statuses = [silent(), silent(), running(), silent(), silent(), running(), silent(), silent(), done()]
    let res
    try {
        res = await videoToItsEnd(t, { generations: [task()], taskStatus: () => statuses.shift() })
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    // Nine polls: had the count run on, the third would have been the request's end.
    assert.equal(polls().length, 9)
    assert.deepEqual(worker.routes(), new Array(11).fill('/egress'))
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: the count is one for the whole request: it runs on from one task to the next — silence at the end of the first and at the start of the second is one run', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const statuses = {
        // The first task is polled out to its sixtieth "not done", and that last poll is let go by.
        'task-1': [...new Array(59).fill(running), silent],
        'task-2': [silent, silent]
    }
    let res
    try {
        res = await videoToItsEnd(t, {
            generations: [picture('')],
            chatDetail: withTwoTasksInHistory,
            taskStatus: id => (statuses[id].shift() || running)()
        })
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    // Had each task counted for itself, the second would have been let go by twice, and polled a third time.
    assert.equal(pollsOf('task-1'), 60)
    assert.equal(pollsOf('task-2'), 2, 'the second task: two polls, and the second of them was the third in a row')
})

test('Qwen2API-03v: a lookup in the chat that qwen.ai is silent on is let go by like a poll of the task — the picture is had on the third lookup', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    const details = [silent(), failedRoad(), withPictureInHistory()]
    let res
    let warned
    warned = await withWarnings(async () => {
        qwenBehindThePage({ generations: [picture('')], chatDetail: () => details.shift() })
        res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)
    assert.equal(lookups().length, 3)
    assert.deepEqual(worker.routes(), ['/egress', '/egress', '/egress', '/egress', '/egress'])
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
    assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 2)
    assert.equal(warned.filter(line => line.includes(GIVEN_UP)).length, 0)
})

test('Qwen2API-03v: three silent lookups in a row — the same 503, after three lookups and not five', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    let res
    let warned
    warned = await withWarnings(async () => {
        qwenBehindThePage({ generations: [picture('')], chatDetail: silent })
        res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    })
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    assert.equal(lookups().length, 3, 'two let go by, and the third is the last')
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
    assert.ok(warned.some(line => line.includes(GIVEN_UP)))
})

test('Qwen2API-03v: an answer between silent lookups of the chat starts the count over — for a picture too', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    // Five lookups is all a picture is given: two silent, an answer with no picture in it, a silent one, and the picture.
    const details = [silent(), failedRoad(), emptyChat(), silent(), withPictureInHistory()]
    let res
    let warned
    warned = await withWarnings(async () => {
        qwenBehindThePage({ generations: [picture('')], chatDetail: () => details.shift() })
        res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.choices[0].message.content, `![image](${IMAGE_URL})`)
    assert.equal(lookups().length, 5)
    assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 3)
    assert.equal(warned.filter(line => line.includes(GIVEN_UP)).length, 0)
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a lookup let go by is one of the five — let go by on the last, it ends in the picture\'s own "no link", not in the 503', { timeout: 10000 }, async () => {
    throughThePage()
    const account = givenAccount()
    // Two silent, two answers with no picture in them, and the fifth goes by: nothing is left to look for the picture.
    const details = [silent(), silent(), emptyChat(), emptyChat(), silent()]
    let res
    let warned
    warned = await withWarnings(async () => {
        qwenBehindThePage({ generations: [picture('')], chatDetail: () => details.shift() })
        res = response()
        await withAccount(account, () => handleImageVideoCompletion({ body: T2I }, res))
    })
    // The request spent its lookups, as after five "not ready yet": the error is the loop's own.
    assert.equal(res.statusCode, 500)
    assert.ok(JSON.stringify(res.body).includes('上游未返回图片链接'))
    assert.equal(lookups().length, 5)
    // What became of the last lookup is in the log, and nowhere else.
    assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 3)
    assert.equal(warned.filter(line => line.includes(GIVEN_UP)).length, 0)
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a video whose task is looked up in the chat through the silence, and then polled through more of it', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // In the chat: two silent lookups, an answer with no task in it, a silent one, and the answer that names the task.
    // Had the count run on through the answer, the fourth lookup would have been the third in a row.
    const details = [silent(), failedRoad(), emptyChat(), silent(), withTaskInHistory()]
    const statuses = [silent(), failedRoad(), done()]
    let res
    try {
        res = await videoToItsEnd(t, {
            generations: [picture('')],
            chatDetail: () => details.shift(),
            taskStatus: () => statuses.shift()
        })
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.choices[0].message.content.includes(VIDEO_URL))
    assert.equal(lookups().length, 5)
    assert.equal(polls().length, 3)
    assert.deepEqual(worker.routes(), new Array(10).fill('/egress'))
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: what is not qwen.ai\'s silence still ends the request at once — the worker\'s refusal, the limit of pages, a session refused, a challenge', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const SESSION_FAILURE = { error: 'Qwen session authorization rejected; this is not Qwen2API client authentication', code: 'upstream_session_unauthorized' }
    try {
        for (const [reply, status, body, pollCount, what] of [
            [() => refused(502, 'page_closed'), 503, TRANSPORT_FAILURE, 1, 'a page that closed'],
            [() => refused(502, 'page_fault'), 503, TRANSPORT_FAILURE, 1, 'a script of the page cut the call'],
            [() => refused(502, 'egress_too_large'), 503, TRANSPORT_FAILURE, 1, 'an answer over the page\'s limit'],
            [() => refused(503, 'resident_capacity'), 503, TRANSPORT_FAILURE, 1, 'the limit of pages'],
            [() => unauthorized(), 502, SESSION_FAILURE, 2, 'a session refused, and refused again after the reload'],
            [() => challenged(), 503, { error: 'Qwen requires WAF/CAPTCHA verification', code: 'upstream_waf_challenge', retry_after: 30 }, 2, 'a challenge page, twice']
        ]) {
            worker.calls.length = 0
            logs.length = 0
            let warned
            let res
            warned = await withWarnings(async () => {
                res = await videoToItsEnd(t, { generations: [task()], taskStatus: reply })
            })
            assert.equal(res.statusCode, status, what)
            assert.deepEqual(res.body, body, what)
            assert.equal(polls().length, pollCount, `${what}: the poll is not gone on with`)
            assert.equal(
                warned.filter(line => line.includes(SILENT_POLL) || line.includes(GIVEN_UP)).length, 0,
                `${what}: none of it is qwen.ai's silence`
            )
        }
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(worker.count('/session'), 0, 'none of it costs a password')
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a lookup in the chat of a video that the worker cannot carry ends the request at once — it is not looked up five times over', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
        for (const code of ['page_closed', 'page_fault']) {
            worker.calls.length = 0
            logs.length = 0
            let warned
            let res
            warned = await withWarnings(async () => {
                res = await videoToItsEnd(t, { generations: [picture('')], chatDetail: () => refused(502, code) })
            })
            assert.equal(res.statusCode, 503, code)
            assert.deepEqual(res.body, TRANSPORT_FAILURE, code)
            assert.equal(lookups().length, 1, `${code}: one lookup, and it was the last`)
            assert.equal(polls().length, 0, code)
            assert.equal(warned.filter(line => line.includes(SILENT_POLL) || line.includes(GIVEN_UP)).length, 0, code)
        }
    } finally {
        t.mock.timers.reset()
    }
    assert.equal(worker.count('/renew'), 0)
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a worker that is not there when the task is polled ends the request at once — it carries no code to let go by', { timeout: 15000 }, async t => {
    throughThePage()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const there = config.signinWorkerUrl
    let res
    let warned
    try {
        // The worker is there for the chats/new and for the generation, and is gone by the first poll.
        const stream = task()
        warned = await withWarnings(async () => {
            res = await videoToItsEnd(t, {
                generations: [{
                    open: (serverResponse, request) => {
                        config.signinWorkerUrl = 'http://127.0.0.1:1'
                        return stream.open(serverResponse, request)
                    }
                }],
                taskStatus: done
            })
        })
    } finally {
        config.signinWorkerUrl = there
        t.mock.timers.reset()
    }
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, TRANSPORT_FAILURE)
    // The poll never reached the worker: it is not among what the worker was sent.
    assert.equal(worker.sent('/egress').length, 2)
    assert.equal(warned.filter(line => line.includes(SILENT_POLL)).length, 0)
    assert.deepEqual(direct, [])
})

/* ------------------------------------- files: STS token and parse from the page (Qwen2API-03v) -- */

const upload = require('../src/utils/upload')
const { ContextExternalizationError } = require('../src/utils/upstream-error')
const OSS = require('ali-oss')
const CONTENT = Buffer.from('file content')
// The STS call's body, as the direct path builds it.
const STS_BODY = { filename: 'upload.txt', filesize: CONTENT.length, filetype: 'file' }

// OSS is ali-oss's own client, not axios: its put is what stands between the test and its network.
async function withOssPut(put, fn) {
    const real = OSS.prototype.put
    OSS.prototype.put = put
    try {
        return await fn()
    } finally {
        OSS.prototype.put = real
    }
}
const putRecording = puts => async function (objectKey, content) {
    puts.push({ objectKey, content: content.toString(), agent: this.agent ?? null, urllib: this.urllib ?? null })
    return { res: { status: 200 } }
}
const qwenFilesBehindThePage = (sts, parse, parseStatus) => {
    worker.script.egress = body => {
        assert.equal(body.stream, undefined, 'a whole-answer call')
        const pathname = new URL(body.url).pathname
        if (pathname === '/api/v1/files/getstsToken') return typeof sts === 'function' ? sts() : sts
        if (pathname === '/api/v2/files/parse') return typeof parse === 'function' ? parse() : parse
        if (pathname === '/api/v2/files/parse/status') return typeof parseStatus === 'function' ? parseStatus() : parseStatus
        throw new Error(`nothing on the page answers ${pathname}`)
    }
}
const PARSE_OK = () => json({ success: true, data: {} })
const parsed = fileId => () => json({ success: true, data: { list: [{ file_id: fileId, status: 'success' }] } })

test('Qwen2API-03v: the STS token is asked of the page, with no Bearer — and the file\'s bytes go to OSS directly, as before', async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(() => json({ success: true, data: STS }))
    const puts = []

    const result = await withOssPut(putRecording(puts), () =>
        upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account))
    assert.deepEqual(
        { status: result.status, file_url: result.file_url, file_id: result.file_id },
        { status: 200, file_url: STS.file_url, file_id: STS.file_id }
    )

    const [call] = worker.sent('/egress')
    assert.equal(call.url, STS_TOKEN)
    assert.equal(call.method, 'POST')
    assert.equal(call.timeoutMs, 30000)
    assert.deepEqual(JSON.parse(call.body), STS_BODY)
    assert.deepEqual(Object.keys(call.headers).sort(), ['content-type', 'x-request-id'])
    assert.equal(call.headers['content-type'], 'application/json')
    assert.equal(bringsBearer(call), false)
    // The bytes never enter the page: OSS is not qwen.ai, and the worker lets nothing leave for it.
    assert.equal(puts.length, 1)
    assert.equal(puts[0].objectKey, STS.file_path)
    assert.equal(puts[0].content, CONTENT.toString())
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: a file is parsed by the page — parse, then its status — with no Bearer', async () => {
    const account = givenAccount()
    const statuses = [
        json({ success: true, data: { list: [{ file_id: 'file-1', status: 'parsing' }] } }),
        json({ success: true, data: { list: [{ file_id: 'file-1', status: 'success' }] } })
    ]
    qwenFilesBehindThePage(json({ success: true, data: STS }), PARSE_OK, () => statuses.shift())

    const ok = await upload.parseUploadedTextFile('file-1', account.token, account, { intervalMs: 5, maxAttempts: 10, timeoutMs: 20000 })
    assert.equal(ok, true)
    assert.deepEqual(worker.sent('/egress').map(call => [call.method, new URL(call.url).pathname, JSON.parse(call.body), call.timeoutMs]), [
        ['POST', '/api/v2/files/parse', { file_id: 'file-1' }, 20000],
        ['POST', '/api/v2/files/parse/status', { file_id_list: ['file-1'] }, 20000],
        ['POST', '/api/v2/files/parse/status', { file_id_list: ['file-1'] }, 20000]
    ])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false])
    assert.ok(worker.sent('/egress').every(call => Object.keys(call.headers).sort().join() === 'content-type,x-request-id'))
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: an agent context file goes up whole — STS of the page, bytes to OSS, parse by the page', async () => {
    const account = givenAccount()
    upload.resetParseBreaker()
    upload.resetParseRateLimiter()
    qwenFilesBehindThePage(() => json({ success: true, data: STS }), PARSE_OK, parsed(STS.file_id))
    const puts = []

    const descriptor = await withOssPut(putRecording(puts), () =>
        upload.uploadAgentContextFile('the long history', account.token, account, { intervalMs: 5, maxAttempts: 5 }))
    assert.equal(descriptor.id, STS.file_id)
    assert.equal(descriptor.url, STS.file_url)
    assert.equal(puts.length, 1)
    // STS, parse, the status: three calls, all the page's.
    assert.deepEqual(worker.sent('/egress').map(call => new URL(call.url).pathname), [
        '/api/v1/files/getstsToken', '/api/v2/files/parse', '/api/v2/files/parse/status'
    ])
    assert.deepEqual(worker.sent('/egress').map(bringsBearer), [false, false, false])
    assert.deepEqual(direct, [])
})

test('Qwen2API-03v: the STS call refused as unauthorized is recovered with one reload and one retry', async () => {
    const account = givenAccount()
    const answers = [unauthorized(), json({ success: true, data: STS })]
    qwenFilesBehindThePage(() => answers.shift())
    const puts = []

    const result = await withOssPut(putRecording(puts), () =>
        upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account))
    assert.equal(result.status, 200)
    assert.equal(puts.length, 1)
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
})

test('Qwen2API-03v: a worker that cannot carry the STS call is the 503 at once — not three retries, and no upload', async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(refused(502, 'page_closed'))
    const puts = []

    await assert.rejects(withOssPut(putRecording(puts), () =>
        upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account)), callRefused('upstream_transport_error', 503))
    // The direct path retried a timed-out STS call three times: a worker that
    // cannot carry it is not asked again, and nothing of it is uploaded.
    assert.deepEqual(worker.routes(), ['/egress'])
    assert.equal(puts.length, 0)
    assert.equal(worker.count('/renew'), 0)
})

test('Qwen2API-03v: a worker that cannot carry a parse call ends the parse at once — no thirty polls', async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(json({ success: true, data: STS }), () => refused(502, 'page_closed'))

    await assert.rejects(upload.parseUploadedTextFile('file-1', account.token, account, { intervalMs: 5, maxAttempts: 30 }),
        callRefused('upstream_transport_error', 503))
    assert.equal(worker.count('/egress'), 1)
})

test('Qwen2API-03v: a parse answered with a challenge page twice is the challenge the direct path names — and its status is never polled', async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(json({ success: true, data: STS }), () => challenged())

    await assert.rejects(upload.parseUploadedTextFile('file-1', account.token, account, { intervalMs: 5, maxAttempts: 30 }), error => {
        // The parse breaker's strike and the client's Retry-After: named as the direct path names it.
        assert.equal(error.code, 'qwen_parse_waf_challenge')
        assert.equal(error.parseCode, 'WAF_CAPTCHA')
        assert.equal(error.egress, 'direct')
        assert.match(error.message, /WAF_CAPTCHA/)
        assert.equal(new ContextExternalizationError(error).publicMessage, 'Upstream WAF is challenging document parse; retry shortly')
        return true
    })
    assert.deepEqual(worker.sent('/egress').map(call => new URL(call.url).pathname), ['/api/v2/files/parse', '/api/v2/files/parse'])
    assert.deepEqual(worker.routes(), ['/egress', '/renew', '/egress'])
    await until(() => sessionPersistence.renewals.size === 0)
    assert.equal(worker.count('/session'), 0)
})

test('Qwen2API-03v: three challenged parses through the page open the parse breaker — nothing is uploaded while it is open', { timeout: 15000 }, async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(() => json({ success: true, data: STS }), () => challenged())
    const puts = []
    const context = { intervalMs: 5 }

    for (let i = 1; i <= 3; i++) {
        upload.resetParseRateLimiter()
        await assert.rejects(withOssPut(putRecording(puts), () =>
            upload.uploadAgentContextFile('the long history', account.token, account, context)), error => {
            assert.equal(error.code, 'qwen_parse_waf_challenge', `upload ${i}`)
            // The third one opens the breaker, and says how long for.
            assert.equal(error.retryAfterSeconds, i < 3 ? undefined : config.agentParseBreakerSeconds, `upload ${i}`)
            return true
        })
    }
    assert.equal(puts.length, 3)

    // Open: the next one is refused before a byte leaves — with the wait the client is to back off by.
    upload.resetParseRateLimiter()
    worker.calls.length = 0
    await assert.rejects(withOssPut(putRecording(puts), () =>
        upload.uploadAgentContextFile('the long history', account.token, account, context)), error => {
        assert.equal(error.breakerOpen, true)
        assert.ok(error.retryAfterSeconds > 0 && error.retryAfterSeconds <= config.agentParseBreakerSeconds)
        return true
    })
    assert.deepEqual(worker.routes(), [])
    assert.equal(puts.length, 3, 'no upload while the breaker is open')
    upload.resetParseBreaker()
})

test('Qwen2API-03v: the STS call is retried on qwen.ai\'s 5xx and on its silence, as it always was', { timeout: 15000 }, async () => {
    const account = givenAccount()
    for (const [first, what] of [[() => json({ success: false }, 503), 'a 5xx'], [() => refused(504, 'egress_timeout'), 'a timeout']]) {
        worker.calls.length = 0
        const puts = []
        const answers = [first, () => json({ success: true, data: STS })]
        qwenFilesBehindThePage(() => answers.shift()())

        const result = await withOssPut(putRecording(puts), () =>
            upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account))
        assert.equal(result.status, 200, what)
        // Asked once more, and no more than the direct path asked: nothing of the page is touched for it.
        assert.deepEqual(worker.routes(), ['/egress', '/egress'], what)
        assert.equal(puts.length, 1, what)
    }
})

test('Qwen2API-03v: a 403 on the STS call is still the token error it was, and is not retried', async () => {
    const account = givenAccount()
    qwenFilesBehindThePage(() => json({ success: false, code: 'Forbidden' }, 403))

    await assert.rejects(upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account), { message: '认证失败，请检查Token权限' })
    assert.deepEqual(worker.routes(), ['/egress'])
})

test('Qwen2API-03v: what qwen.ai answers the parse with is read as it always was', async () => {
    const account = givenAccount()
    // The shape measured on 2026-09-09: HTTP 200, success:false, the service's own code.
    qwenFilesBehindThePage(null, () => json({ success: false, data: { code: 'Internal_Server_Error' } }))

    await assert.rejects(upload.parseUploadedTextFile('file-1', account.token, account, { intervalMs: 5, maxAttempts: 30 }), error => {
        assert.equal(error.code, 'qwen_parse_unavailable')
        assert.equal(error.parseCode, 'Internal_Server_Error')
        return true
    })
    assert.equal(worker.count('/egress'), 1, 'on the first call, as before')
})

test('Qwen2API-03v: with chats/new direct, STS and parse stay on axios, with the Bearer they always carried', async () => {
    config.chatCreationTransport = 'direct'
    const account = givenAccount()
    directReply = async url => {
        if (url.endsWith('/api/v1/files/getstsToken')) return { status: 200, data: STS }
        if (url.endsWith('/api/v2/files/parse')) return { data: { success: true, data: {} } }
        if (url.endsWith('/api/v2/files/parse/status')) return { data: { success: true, data: { list: [{ file_id: STS.file_id, status: 'success' }] } } }
        assert.fail(`no direct call to ${url} is scripted`)
    }

    const result = await withOssPut(putRecording([]), () => upload.uploadFileToQwenOss(CONTENT, 'upload.txt', account.token, account))
    assert.equal(result.status, 200)
    assert.equal(await upload.parseUploadedTextFile(STS.file_id, account.token, account, { intervalMs: 5 }), true)
    assert.deepEqual(direct.map(call => new URL(call.url).pathname), [
        '/api/v1/files/getstsToken', '/api/v2/files/parse', '/api/v2/files/parse/status'
    ])
    assert.deepEqual(direct.map(bearerOf), [`Bearer ${account.token}`, `Bearer ${account.token}`, `Bearer ${account.token}`])
    assert.equal(worker.calls.length, 0, 'the worker is not involved')
})
