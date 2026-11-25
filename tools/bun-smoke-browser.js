'use strict'

/*
 * Browser-mode scenario of the smoke test (Qwen2API-3ue.7).
 *
 * On prod the application is a compiled Bun binary with v2 browser sessions,
 * and every qwen.ai call leaves through the signin worker's resident page.
 * Neither the test gate (everything from source) nor the rest of this smoke
 * (v1 mode: no sessions, no worker) runs that path as a binary — which is how
 * a session recovery that only fails where account.js is not a file on disk
 * lived from E.2 to the live rollout of 2026-11-24.
 *
 * So the application runs here as this run can start it — from source, as the
 * native executable, or as the container — with the flags of prod, against one
 * loopback stand-in for the worker and for qwen.ai:
 *
 *   V2_SESSION_MODE=browser, CHAT_CREATION_TRANSPORT=browser,
 *   COMPLETIONS_TRANSPORT=browser, SIGNIN_WORKER_TOKEN set
 *
 * and with both addresses it reads for qwen.ai pointing at the stand-in too:
 * the generation path reaches "qwen.ai" through /egress, or it fails.
 *
 * The scenario:
 *   1. an account is added through the worker (one /session);
 *   2. its first chats/new is refused as a session: the page is reloaded
 *      (/renew), the call is made once more and the answer comes through the
 *      relay — the log says the session was renewed, and the account record
 *      followed it, on disk;
 *   3. the relay hands the frames on as they arrive, not once they are all in;
 *   4. a relay the worker could not carry ends in an error event: the
 *      application makes the call once more, and the client gets the answer;
 *   5. after a restart the session is back from disk: no sign-in, no reload;
 *   6. a WAF challenge page is a real 503: one reload, one retry, no password;
 *   7. what left for qwen.ai, and how — no Bearer of the app's on any /egress
 *      (Qwen2API-jr9), the worker's token on every worker call, chats/new and
 *      completions never asked for directly.
 *
 * The answers of the stand-in have the shapes of
 * tests/browser-egress.test.js (standInWorker) and
 * tests/signin-worker-egress-stream.test.js.
 */

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const API_KEY = 'bun-smoke-browser-key'
const WORKER_TOKEN = 'bun-smoke-browser-worker-token'
const EMAIL = 'browser@example.invalid'
const PASSWORD = 'local-test-password'
const MODEL = 'qwen-smoke-browser'
const CHAT_ID = 'smoke-browser-chat'
const ANSWER = 'OK'
// What a refusal of the upstream carries: it must reach neither the client's answer nor the log.
const SECRET = 'private-upstream-refusal-browser-fixture'

// A session token as the worker harvests one: a JWT shape whose payload says which session it is.
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 30 * 86400
const tokenWith = label => [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: EMAIL, label, exp: EXPIRES_AT })).toString('base64url'),
    'fixture'
].join('.')
const sessionOf = token => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).label
const cookie = (name, value) => ({ name, value, domain: 'chat.qwen.ai', path: '/', secure: true })

// qwen.ai's answer to a streamed completions call: the frames the v1 upstream answers with above.
const frame = delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`
const FIRST_FRAME = frame({ phase: 'answer', content: ANSWER })
const REST = `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
})}\n\ndata: [DONE]\n\n`

/**
 * A loopback stand-in for the two services the application talks to in browser
 * mode: the signin worker (/session, /renew, /egress) and qwen.ai itself.
 * qwen.ai is asked directly for one thing only, the model list; everything
 * else reaches it from inside the account's page, i.e. through /egress. The
 * page is on a session of its own: a sign-in or a forced reload puts it on
 * one, and a call that brings an authorization of its own is refused, as the
 * app's was on 2026-11-24 (Qwen2API-jr9).
 */
function standIn() {
    const calls = []
    const direct = []
    const failures = []
    const state = {
        // The session the page is on (null: logged out).
        page: null,
        // qwen.ai's verdicts on the page's next chats/new calls, in order; then a chat is accepted.
        chatsNew: [],
        // A promise from the scenario: the rest of the next streamed answer waits for it.
        hold: null,
        // The code the next relay fails with, before it has a head to send.
        failRelay: null
    }
    const server = createServer((request, response) => {
        let raw = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { raw += chunk })
        request.on('end', async () => {
            try {
                await answer(request, response, raw)
            } catch (error) {
                failures.push(error)
                response.destroy()
            }
        })
    })

    async function answer(request, response, raw) {
        const { pathname } = new URL(request.url, 'http://stand-in.invalid')
        const json = (status, payload) => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(payload))
        }
        if (!['/session', '/renew', '/egress'].includes(pathname)) {
            direct.push(`${request.method} ${pathname}`)
            if (pathname !== '/api/models') return json(404, { error: `Unexpected direct path: ${pathname}` })
            return json(200, { data: [{
                id: MODEL, name: MODEL, info: { meta: { chat_type: ['t2t'], abilities: {} } }
            }] })
        }
        const authorized = request.headers.authorization === `Bearer ${WORKER_TOKEN}`
        const body = raw ? JSON.parse(raw) : {}
        calls.push({ route: pathname, authorized, body })
        if (!authorized) return json(401, { code: 'unauthorized', message: 'Invalid worker token.' })
        if (pathname !== '/egress') {
            // The page is on the session it hands back from here on.
            const label = pathname === '/session' ? 'signed-in' : body.force === true ? 'renewed' : state.page
            state.page = label
            return json(200, { token: tokenWith(label), expiresAt: EXPIRES_AT, cookies: [cookie('cna', `from-${label}`)] })
        }
        if (body.stream === true) return relay(response, body)
        // What /egress answers: qwen.ai's status and body inside, plus the live jar.
        const egress = (payload, headers = { 'content-type': 'application/json' }) => ({
            status: 200, headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload),
            url: body.url, redirected: false, cookies: [cookie('cna', `from-${state.page}`)]
        })
        const verdict = 'authorization' in (body.headers || {}) ? 'refused' : (state.chatsNew.shift() || 'accepted')
        if (verdict === 'refused') return json(200, egress({ success: false, data: { code: 'unauthorized', details: SECRET } }))
        if (verdict === 'challenge') {
            return json(200, egress('<!doctype html><meta name="aliyun_waf_aa" content="x"></meta><title>Verification</title>',
                { 'content-type': 'text/html; charset=utf-8' }))
        }
        return json(200, egress({ success: true, data: { id: CHAT_ID } }))
    }

    // The worker's streaming /egress: one JSON event per line, as the app reads them.
    async function relay(response, call) {
        const hold = state.hold
        state.hold = null
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const event = payload => response.write(`${JSON.stringify(payload)}\n`)
        // A relay the worker could not carry owns its answer: it says so with an error event, as it goes.
        if (state.failRelay) {
            const code = state.failRelay
            state.failRelay = null
            return response.end(`${JSON.stringify({
                type: 'error', code, message: `In-page fetch failed (${code}).`
            })}\n`)
        }
        // The app closing its side of the relay is how it says "stop".
        const gone = new Promise(resolve => response.once('close', resolve))
        event({
            type: 'head', status: 200, url: call.url, redirected: false,
            headers: { 'content-type': 'text/event-stream' }, cookies: [cookie('cna', 'from-head')]
        })
        event({ type: 'chunk', data: Buffer.from(FIRST_FRAME).toString('base64') })
        await Promise.race([hold || Promise.resolve(), gone])
        event({ type: 'chunk', data: Buffer.from(REST).toString('base64') })
        response.end(`${JSON.stringify({ type: 'end', cookies: [cookie('ssxmod_itna', 'from-end')] })}\n`)
    }

    return {
        state, calls, direct, failures, server,
        routes: () => calls.map(call => call.route),
        to: route => calls.filter(call => call.route === route).map(call => call.body)
    }
}

const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const closeListener = server => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
}

// The log as it reads without colors, and the lines of it that say what became of a request.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const plain = text => text.replace(ANSI, '')
const evidence = logs => plain(logs).split('\n')
    .filter(line => /v2 |V2SESSION|CHAT|chat creation|signin-worker|MODULE_NOT_FOUND|upstream|Error/.test(line))
    .slice(-30).join('\n')

// `promise`, or a rejection once `ms` passed — the timer gone either way.
const within = async (promise, ms, message) => {
    let timer
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms)
        })])
    } finally {
        clearTimeout(timer)
    }
}
// Poll until the condition holds. A condition that throws (a file in the middle of being
// written) is asked again; once the time is up, the log says what the application did.
async function until(condition, message, logs, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        let failure = ''
        try {
            if (await condition()) return
        } catch (error) {
            failure = ` (${error.message})`
        }
        assert.ok(Date.now() < deadline, `${message}${failure}:\n${evidence(logs)}`)
        await delay(50)
    }
}

// The frames of a server-sent-events answer, each as its data lines, as they reach the client.
async function* serverEvents(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
            for (let end = /\r?\n\r?\n/.exec(text); end; end = /\r?\n\r?\n/.exec(text)) {
                const data = text.slice(0, end.index).split(/\r?\n/)
                    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
                text = text.slice(end.index + end[0].length)
                // A heartbeat frame carries no data.
                if (data) yield data
            }
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
}

/**
 * @param {object} options
 * @param {Function} options.startApplication - ({ containerName, temporaryDirectory,
 *   serviceEnvironment }) => how this run can start the application (tools/bun-smoke.js)
 * @param {Function} options.stopApplication - (application) => its exit code
 * @param {Function} options.disposeApplication - (application): what is left of it goes
 * @param {string} [options.binaryPath]
 * @param {string} [options.dockerImage]
 */
async function run({ startApplication, stopApplication, disposeApplication, binaryPath, dockerImage }) {
    const standalone = Boolean(binaryPath || dockerImage)
    const worker = standIn()
    const upstream = `http://127.0.0.1:${await listen(worker.server)}`
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'qwen-bun-smoke-browser-'))
    const containerBase = `qwen-smoke-browser-${randomUUID()}`
    const dataFile = path.join(temporaryDirectory, 'data/data.json')
    const sessionsFile = path.join(temporaryDirectory, 'data/v2-sessions.json')
    const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
    let application = null
    let launches = 0
    let baseUrl
    try {
        await mkdir(path.join(temporaryDirectory, 'data'))
        if (standalone) await writeFile(path.join(temporaryDirectory, '.env'), `API_KEY=${API_KEY}\n`)

        // The application as prod runs it: browser sessions, every call through the page. Its two
        // qwen.ai addresses point at the stand-in as well: a direct call has nowhere else to go,
        // and the stand-in writes down each one.
        const environment = servicePort => ({
            NODE_ENV: 'production',
            // From source there is no entry point to keep its files out of the checkout.
            ...(standalone ? {} : { API_KEY, QWEN2API_RUNTIME_DIR: temporaryDirectory }),
            SERVICE_PORT: String(servicePort),
            LISTEN_ADDRESS: '127.0.0.1',
            DATA_SAVE_MODE: 'file',
            ENABLE_CLI: 'false',
            ENABLE_FILE_LOG: standalone ? 'true' : 'false',
            LOG_LEVEL: 'INFO',
            CACHE_MODE: standalone ? 'file' : 'default',
            V2_SESSION_MODE: 'browser',
            SIGNIN_WORKER_URL: upstream,
            SIGNIN_WORKER_TOKEN: WORKER_TOKEN,
            CHAT_CREATION_TRANSPORT: 'browser',
            COMPLETIONS_TRANSPORT: 'browser',
            QWEN_CHAT_PROXY_URL: upstream,
            QWEN_CLI_PROXY_URL: upstream
        })
        const start = async () => {
            const reservation = createServer()
            const servicePort = await listen(reservation)
            await new Promise(resolve => reservation.close(resolve))
            baseUrl = `http://127.0.0.1:${servicePort}`
            application = await startApplication({
                containerName: `${containerBase}-${++launches}`, temporaryDirectory, serviceEnvironment: environment(servicePort)
            })
            const deadline = Date.now() + 20000
            for (;;) {
                if (application.spawnError) throw application.spawnError
                assert.equal(application.process.exitCode, null, `Application exited early:\n${application.logs}`)
                try {
                    const response = await fetch(`${baseUrl}/api/getAllAccounts`, {
                        headers: { 'x-api-key': API_KEY }, signal: AbortSignal.timeout(2000)
                    })
                    if (response.ok && Array.isArray((await response.json()).data)) return
                } catch { /* not listening yet */ }
                assert.ok(Date.now() < deadline, `Application did not become ready:\n${application.logs}`)
                await delay(100)
            }
        }
        const request = (route, options = {}) => fetch(`${baseUrl}${route}`, {
            signal: AbortSignal.timeout(30000), ...options
        })
        const jsonHeaders = { 'Content-Type': 'application/json', 'x-api-key': API_KEY }
        const chat = (stream, content = 'Reply OK.') => request('/v1/chat/completions', {
            method: 'POST', headers: jsonHeaders,
            body: JSON.stringify({ model: MODEL, max_tokens: 32, stream, messages: [{ role: 'user', content }] })
        })
        // An answer read to its end: one that never ends must not hang the smoke.
        const whole = async response => ({
            status: response.status, headers: response.headers, text: await within(response.text(), 30000, 'the answer did not end in 30 s')
        })
        const log = () => plain(application.logs)
        const wait = (condition, message) => until(condition, message, application.logs)
        await start()

        // 1. The account is added through the worker: one sign-in, on the worker's token.
        const added = await whole(await request('/api/setAccount', {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: EMAIL, password: PASSWORD })
        }))
        assert.equal(added.status, 200, added.text)
        assert.deepEqual(worker.routes(), ['/session'])
        assert.deepEqual(worker.to('/session')[0], { email: EMAIL, password: PASSWORD, proxy: null })
        console.log('PASS: browser mode — an account is added through the worker')

        // 2. The first chats/new is refused as a session: reload, retry, and the answer through the relay.
        worker.state.chatsNew.push('refused')
        const first = await whole(await chat(false))
        // What the binary did on 2026-11-24, said by itself: the recovery failed inside it (MODULE_NOT_FOUND).
        assert.ok(!log().includes('MODULE_NOT_FOUND'), `a session recovery failed in the application:\n${evidence(application.logs)}`)
        assert.equal(first.status, 200, `${first.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(first.text).choices[0].message.content, ANSWER, first.text)
        await wait(() => (log().match(/v2 会话已续期/g) || []).length === 1, 'the log does not say the session was renewed')
        assert.deepEqual(worker.routes(), ['/session', '/egress', '/renew', '/egress', '/egress'])
        assert.deepEqual(worker.to('/renew')[0], { email: EMAIL, proxy: null, force: true }, 'a refused session is a forced reload')
        // What the page is asked for: the application builds it on QWEN_CHAT_PROXY_URL, which is the
        // stand-in here — and is qwen.ai's address on prod.
        assert.deepEqual(worker.to('/egress').map(call => call.url), [
            `${upstream}/api/v2/chats/new`, `${upstream}/api/v2/chats/new`,
            `${upstream}/api/v2/chat/completions?chat_id=${CHAT_ID}`
        ])
        assert.equal(worker.to('/egress')[2].stream, true, 'completions go out as a stream')
        // The account record followed the renewed session — in storage, where the binary keeps it.
        await wait(async () => sessionOf((await readJson(dataFile)).accounts[0].token) === 'renewed',
            'the account record did not follow the renewed session')
        await wait(async () => sessionOf((await readJson(sessionsFile)).sessions[EMAIL].token) === 'renewed',
            'the renewed session did not reach storage')
        assert.ok(!first.text.includes(SECRET) && !application.logs.includes(SECRET), 'raw upstream content must stay private')
        console.log('PASS: browser mode — a refused session is renewed and the request retried; the answer comes through the relay')

        // 3. The frames of a stream reach the client as they arrive: qwen.ai holds the rest of the
        //    answer back until the client has the first frame.
        const egressCallsBefore = worker.to('/egress').length
        let release
        worker.state.hold = new Promise(resolve => { release = resolve })
        const streamed = await chat(true)
        assert.match(streamed.headers.get('content-type') || '', /text\/event-stream/)
        const frames = []
        let firstFrameArrived
        const arrived = new Promise(resolve => { firstFrameArrived = resolve })
        const reading = (async () => {
            for await (const data of serverEvents(streamed)) {
                frames.push(data)
                if (frames.length === 1) firstFrameArrived()
            }
        })()
        // It may fail after the scenario gave up on it.
        reading.catch(() => {})
        await within(arrived, 15000, `the first frame did not reach the client while the rest was still upstream:\n${evidence(application.logs)}`)
        release()
        await within(reading, 30000, 'the answer did not end in 30 s')
        assert.equal(frames.filter(data => data !== '[DONE]').map(data => JSON.parse(data).choices?.[0]?.delta?.content || '').join(''), ANSWER)
        assert.equal(frames.at(-1), '[DONE]')
        // One chats/new and one completions call for the whole answer: the frames ride one relay.
        assert.deepEqual(worker.to('/egress').slice(egressCallsBefore).map(call => call.stream === true), [false, true])
        console.log('PASS: browser mode — a streamed answer reaches the client frame by frame')

        // 4. A relay the worker could not carry is not the client's failure: the application
        //    makes the completions call once more, on the chat it already has.
        worker.state.failRelay = 'egress_timeout'
        const callsBeforeFailure = worker.routes().length
        const retried = await whole(await chat(false))
        assert.equal(retried.status, 200, `${retried.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(retried.text).choices[0].message.content, ANSWER, retried.text)
        assert.deepEqual(worker.routes().slice(callsBeforeFailure), ['/egress', '/egress', '/egress'],
            'one chats/new, the relay that failed, and one more completions call')
        assert.ok(!retried.text.includes('In-page fetch failed'), 'the relay\'s failure is not the client\'s answer')
        // What the application made of it: a timed-out transport, worth one more try.
        assert.match(log(), /聊天请求传输错误 \(尝试 1\/2, code=ETIMEDOUT\): signin-worker egress: egress_timeout/)
        console.log('PASS: browser mode — a relay that fails is retried, and the client gets the answer')

        // 5. The session survives a restart: it is read back from disk, with no sign-in and no reload.
        await stopApplication(application)
        const callsBeforeRestart = worker.routes().length
        await start()
        await wait(() => /v2 会话恢复完成: 1 个有效/.test(log()), 'the session was not restored at startup')
        const afterRestart = await whole(await chat(true))
        assert.equal(afterRestart.status, 200, afterRestart.text)
        assert.match(afterRestart.text, /data: \[DONE\]/)
        assert.match(afterRestart.text, new RegExp(`"content":"${ANSWER}"`))
        assert.deepEqual(worker.routes().slice(callsBeforeRestart), ['/egress', '/egress'])
        console.log('PASS: browser mode — a session is restored after a restart, with no sign-in and no reload')

        // 6. One WAF challenge page: a real 503 after one reload and one retry — and never a password.
        worker.state.chatsNew.push('challenge', 'challenge')
        const callsBeforeChallenge = worker.routes().length
        const challenged = await whole(await chat(false, '你好'))
        assert.equal(challenged.status, 503, challenged.text)
        assert.equal(JSON.parse(challenged.text).error.code, 'upstream_waf_challenge')
        // A refusal of chats/new is not told to be retried, as on the v1 path.
        assert.equal(challenged.headers.get('retry-after'), null)
        assert.equal(challenged.headers.get('set-cookie'), null)
        assert.deepEqual(worker.routes().slice(callsBeforeChallenge), ['/egress', '/renew', '/egress'])
        console.log('PASS: browser mode — a WAF challenge page is a 503 with one reload and one retry')

        // 7. What left for qwen.ai, and how.
        assert.equal(worker.failures.length, 0, `the stand-in failed: ${worker.failures[0]?.message}`)
        assert.equal(worker.routes().filter(route => route === '/session').length, 1, 'a challenge costs no password')
        assert.ok(worker.calls.every(call => call.authorized), 'every worker call carries SIGNIN_WORKER_TOKEN')
        assert.ok(worker.to('/egress').every(call => call.email === EMAIL), 'every call left from the account\'s page')
        assert.ok(worker.to('/egress').every(call => !('authorization' in call.headers)),
            'the app put a Bearer of its own on an egress call (Qwen2API-jr9)')
        assert.deepEqual([...new Set(worker.direct)], ['GET /api/models'],
            'chats/new and completions must reach qwen.ai through the page only')
        const exitCode = await stopApplication(application)
        if (process.platform !== 'win32') assert.equal(exitCode, 0, 'SIGTERM should exit cleanly')
        assert.ok(!log().includes('MODULE_NOT_FOUND'), `something was not found inside the application:\n${evidence(application.logs)}`)
        assert.match(log(), /chatCreationTransport"?\s*:\s*"?browser/, 'the startup record says chats/new leaves through the page')
        assert.match(log(), /completionsTransport"?\s*:\s*"?browser/, 'the startup record says completions leave through the page')
        console.log('PASS: browser mode — no Bearer of the app\'s on /egress, the worker\'s token on every worker call, clean shutdown')
    } catch (error) {
        console.error(plain(application?.logs || ''))
        if (worker.direct.length) console.error(`The stand-in answered directly: ${worker.direct.join(', ')}`)
        throw error
    } finally {
        if (application) await disposeApplication(application)
        await closeListener(worker.server)
        await rm(temporaryDirectory, { recursive: true, force: true })
    }
}

module.exports = run
