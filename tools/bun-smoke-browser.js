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
 *      then, since Qwen2API-jk9 (2026-11-27), the two ways the first attempt
 *      of a request without a stream died in the first hour of real traffic
 *      on 27.11 — its answer's connection going under it once it began, and a
 *      chats/new the page did not answer in time (the worker's 504): the
 *      application makes the whole request once more, and the client gets the
 *      answer behind a 200;
 *   5. after a restart the session is back from disk: no sign-in, no reload;
 *   6. a WAF challenge page is a real 503: one reload, one retry, no password;
 *   7. the application starts once more, the session back from disk again — each
 *      of the steps below needs a recovery of its own, and prod allows an
 *      account's page one reload in 30 seconds;
 *   8. a file in the prompt (Qwen2API-3ue.11): the token is asked of the page,
 *      the bytes go to the storage the answer names, the page parses the file
 *      and tells its status — and a challenge page on the parse is one reload
 *      and one retry; a token call qwen.ai refuses is the client's 503, with
 *      nothing uploaded;
 *   9. an image is generated through the relay, its link taken from the answer,
 *      the picture fetched directly;
 *  10. an image whose link is not in the answer is looked up in the chat —
 *      through the page;
 *  11. a video is generated through the relay, its answer read whole, its task
 *      polled through the page;
 *  12. an account is removed while its request still waits for qwen.ai's first
 *      frame (Qwen2API-2l0, Qwen2API-u50): the worker is told once (/forget),
 *      the page's stream is cut with the page, and the request's retry does
 *      not reach the worker for the account that is gone;
 *  13. what left for qwen.ai, and how — no Bearer of the app's on any /egress
 *      (Qwen2API-jr9), the worker's token on every worker call, and straight
 *      from the application only the model list, the file's bytes and the picture.
 *
 * The answers of the stand-in have the shapes of
 * tests/browser-egress.test.js (standInWorker) and
 * tests/signin-worker-egress-stream.test.js.
 *
 * Not here: a task that is not done at its first poll (the next one is twenty
 * seconds away — tests/browser-egress.test.js holds that), and a client that
 * goes away (this stand-in cannot see one: tools/client-gone-smoke.js).
 */

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { discardTemporaryDirectory } = require('./remove-directory')

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
// What a relay sends for a generation (steps 8–11): its head's content type and
// its body, in the pieces it arrives in. The text answer unless the scenario says otherwise.
const TEXT_ANSWER = { type: 'text/event-stream', pieces: [FIRST_FRAME, REST] }
// An image's answer is SSE, one frame carrying the picture's link
// (tests/browser-egress.test.js, picture()).
const pictureAnswer = url => ({ type: 'text/event-stream', pieces: [frame({ phase: 'image_gen', content: `![image](${url})` })] })
// One with no link in it: the picture is in the chat's history, for the lookup to find.
const NO_LINK_ANSWER = {
    type: 'text/event-stream',
    pieces: [
        frame({ phase: 'answer', content: 'The picture is in this chat.' }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    ]
}

// A WAF challenge page as qwen.ai serves it under status 200 (2026-11-24).
const CHALLENGE_PAGE = '<!doctype html><meta name="aliyun_waf_aa" content="x"></meta><title>Verification</title>'
// The error page qwen.ai gave the page's token call on 2026-11-25: 405, and HTML.
// No marker of a challenge page in it — a refusal, not a challenge.
const REFUSED_PAGE = '<!doctypehtml><html lang="zh-cn"><meta charset="utf-8"><meta name="data-spm" content="a3c0e"><title>405</title><body>405</body></html>'

// The storage, as the stand-in's STS answer names it (Qwen2API-3ue.11). The
// application sends a file's bytes there straight from Node, as it does to OSS
// on prod, to the address it takes off the answer — and ali-oss keeps an
// explicit http:// over the `secure` it is created with (measured 2026-11-26,
// Bun 1.3.14 and Node 24). So the stand-in is the storage too: no TLS, no
// certificate, and no change to the application.
const BUCKET = 'qwen-smoke-bucket'
// A region that is not one of OSS's. Should the application ever build the
// endpoint from the region again, instead of taking the answer's, the name it
// builds is `oss-smoke-1.aliyuncs.com`: not one this smoke knows a storage
// behind. In a container without a network nothing leaves; on a runner with one,
// a lookup of that name is all that would go out — and the step fails on an
// upload that never reached the stand-in.
const REGION = 'oss-smoke-1'
const ACCESS_KEY_ID = 'smoke-access-key'
const SECURITY_TOKEN = 'smoke-security-token'
const FILE_ID = 'smoke-file-1'
const FILE_PATH = 'smoke-files/agent-context.txt'
const STS_PATH = '/api/v2/files/getstsToken'
const PARSE_PATH = '/api/v2/files/parse'
const PARSE_STATUS_PATH = '/api/v2/files/parse/status'
// What the CDN behind the stand-in holds. A generation answers with a link to
// it; the application fetches the picture itself, straight from Node — the CDN
// is not qwen.ai, and the page is not asked for it.
const PICTURE_PATH = '/cdn/smoke-picture.png'
const VIDEO_PATH = '/cdn/smoke-video.mp4'
// A PNG's signature and a few bytes after it: nothing decodes it, the client gets it back as it is.
const PICTURE_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('the picture of the smoke\n')
])
const VIDEO_TASK = 'smoke-video-task-1'
// A video's answer is JSON — a task to poll, read whole.
const TASK_ANSWER = { type: 'application/json', pieces: [JSON.stringify({ success: true, data: { task_id: VIDEO_TASK } })] }
// The answer to a request with tools. The application's turn gate takes a bare
// text from such a request for a turn that is not over, and asks again — so
// the answer says the turn is over. (The v1 scenario above answers the same way.)
const AGENT_ANSWER = {
    type: 'text/event-stream',
    pieces: [frame({ phase: 'answer', content: `<agent_final>${ANSWER}</agent_final>` }), REST]
}
// How a generation's chats/new is answered, by the kind asked for: each generation
// gets a chat of its own. The text scenario's chat is one and the same (CHAT_ID).
const CHAT_OF = { t2i: 'image', t2v: 'video' }

/**
 * A loopback stand-in for what the application talks to in browser mode: the
 * signin worker (/session, /renew, /egress, /forget), qwen.ai itself, and — behind the
 * same address — the storage a file's bytes go to and the CDN a generation's
 * result lies on. Straight from the application come the model list, a file's
 * bytes and the picture; everything else reaches qwen.ai from inside the
 * account's page, i.e. through /egress. The page is on a session of its own: a
 * sign-in or a forced reload puts it on one, and a call that brings an
 * authorization of its own is refused, as the app's was on 2026-11-24
 * (Qwen2API-jr9).
 */
function standIn() {
    const calls = []
    const direct = []
    const failures = []
    // The puts the storage was asked for, as they arrived.
    const puts = []
    // The accounts the application has dropped (POST /forget, Qwen2API-2l0): a relay of theirs still open is cut.
    // A relay asked for such an account later leaves this set — the page is opened again, as the worker of
    // prod does while the profile is kept (relay()).
    const forgotten = new Set()
    // Lets go the relay held after its head: the /forget that cuts it. Null while none is held.
    let releaseHeld = null
    const state = {
        // The session the page is on (null: logged out).
        page: null,
        // qwen.ai's verdicts on the page's next chats/new calls, in order; then a chat is accepted.
        chatsNew: [],
        // A promise from the scenario: the rest of the next streamed answer waits for it.
        hold: null,
        // True from the scenario: the next streamed answer waits after its head and before its
        // first frame, until the account is forgotten — as the page's stream waits for qwen.ai.
        holdAfterHead: false,
        // The code the next relay fails with, before it has a head to send.
        failRelay: null,
        // The code the next relay's answer breaks with, once it began (Qwen2API-jk9): the error event the
        // worker ends the relay with when qwen.ai's side of it failed. Once: the request the application
        // makes again is carried as any other.
        breakRelay: null,
        // The code the worker refuses the next chats/new with, as it does when the page did not answer
        // the call in time (Qwen2API-jk9): answered as HTTP 504, at once.
        refuseChatsNew: null,
        // What the next relay carries; null: the text answer.
        answer: null,
        // qwen.ai's verdicts on the page's next calls of any other address, by address, in order:
        // 'refused', 'challenge', 'not-allowed', 'parsing'. A list that ran out is the address
        // answered as this scenario needs it.
        answers: {},
        // The chats made for each kind of generation, to give each one a chat of its own.
        chats: {}
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
    // Its own address — qwen.ai's here, and the storage's and the CDN's as the answers name them.
    const origin = () => `http://127.0.0.1:${server.address().port}`

    async function answer(request, response, raw) {
        const { pathname } = new URL(request.url, 'http://stand-in.invalid')
        const json = (status, payload) => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(payload))
        }
        if (!['/session', '/renew', '/egress', '/forget'].includes(pathname)) {
            direct.push(`${request.method} ${pathname}`)
            if (pathname === '/api/models') return json(200, { data: [{
                id: MODEL, name: MODEL, info: { meta: { chat_type: ['t2t'], abilities: {} } }
            }] })
            // The storage: a file's bytes, put there by the application itself.
            if (request.method === 'PUT' && pathname === `/${FILE_PATH}`) {
                puts.push({ headers: request.headers, body: raw })
                response.writeHead(200, { etag: '"smoke-etag"' })
                return response.end()
            }
            // The CDN: the picture behind a generation's link.
            if (request.method === 'GET' && pathname === PICTURE_PATH) {
                response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PICTURE_BYTES.length) })
                return response.end(PICTURE_BYTES)
            }
            return json(404, { error: `Unexpected direct path: ${request.method} ${pathname}` })
        }
        const authorized = request.headers.authorization === `Bearer ${WORKER_TOKEN}`
        const body = raw ? JSON.parse(raw) : {}
        calls.push({ route: pathname, authorized, body, at: Date.now() })
        if (!authorized) return json(401, { code: 'unauthorized', message: 'Invalid worker token.' })
        // The application dropped an account (Qwen2API-2l0). The worker's /forget closes the
        // account's page; a relay of that account still open is cut with it, as a page's stream is
        // when its page closes: an error event, page_closed. A relay asked for the account later
        // is carried as the worker of prod carries it with the profile kept (see relay()).
        if (pathname === '/forget') {
            forgotten.add(body.email)
            const release = releaseHeld
            releaseHeld = null
            release?.()
            return json(200, { ok: true, session: true, page: true, profile: 'kept' })
        }
        if (pathname !== '/egress') {
            // The page is on the session it hands back from here on.
            const label = pathname === '/session' ? 'signed-in' : body.force === true ? 'renewed' : state.page
            state.page = label
            return json(200, { token: tokenWith(label), expiresAt: EXPIRES_AT, cookies: [cookie('cna', `from-${label}`)] })
        }
        if (body.stream === true) return relay(response, body)
        // What /egress answers: qwen.ai's status and body inside, plus the live jar.
        const page = new URL(body.url).pathname
        const egress = (payload, headers = { 'content-type': 'application/json' }, status = 200) => ({
            status, headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload),
            url: body.url, redirected: false, cookies: [cookie('cna', `from-${state.page}`)]
        })
        // qwen.ai's verdict on a call of the page. chats/new's comes from state.chatsNew, any other
        // address's from state.answers; a list that has run out is the address answered as this
        // scenario needs it, below.
        const verdict = 'authorization' in (body.headers || {}) ? 'refused'
            : (page === '/api/v2/chats/new' ? state.chatsNew : (state.answers[page] ||= [])).shift()
        if (verdict === 'refused') return json(200, egress({ success: false, data: { code: 'unauthorized', details: SECRET } }))
        if (verdict === 'challenge') return json(200, egress(CHALLENGE_PAGE, { 'content-type': 'text/html; charset=utf-8' }))
        // The worker's own refusal of a chats/new its page did not answer in time (Qwen2API-jk9), as its
        // HTTP layer writes it (signin-worker/lib/worker-errors.js: egress_timeout is a 504).
        if (page === '/api/v2/chats/new' && state.refuseChatsNew) {
            const code = state.refuseChatsNew
            state.refuseChatsNew = null
            return json(504, { code, message: 'The resident page stopped responding.' })
        }
        // As qwen.ai answered the page's token call where its front end no longer asks (Qwen2API-3ue.12).
        if (verdict === 'not-allowed') return json(200, egress(REFUSED_PAGE, { 'content-type': 'text/html; charset=utf-8' }, 405))
        if (verdict === 'parsing') return json(200, egress({ success: true, data: { list: [{ file_id: FILE_ID, status: 'parsing' }] } }))
        if (page === '/api/v2/chats/new') {
            // A chat of the kind asked for: the text one is the scenario's own, each generation gets its own.
            const kind = JSON.parse(body.body).chat_type || 't2t'
            const id = kind === 't2t' ? CHAT_ID : `smoke-browser-${CHAT_OF[kind] || kind}-${state.chats[kind] = (state.chats[kind] || 0) + 1}`
            return json(200, egress({ success: true, data: { id } }))
        }
        // The token of a file: the storage is this stand-in, and the answer says so (Qwen2API-3ue.11).
        if (page === STS_PATH) return json(200, egress({ success: true, data: {
            access_key_id: ACCESS_KEY_ID, access_key_secret: 'smoke-access-secret', security_token: SECURITY_TOKEN,
            bucketname: BUCKET, region: REGION, endpoint: origin(),
            file_id: FILE_ID, file_path: FILE_PATH, file_url: `${origin()}/${FILE_PATH}`
        } }))
        if (page === PARSE_PATH) return json(200, egress({ success: true, data: {} }))
        if (page === PARSE_STATUS_PATH) return json(200, egress({ success: true, data: { list: [{ file_id: FILE_ID, status: 'success' }] } }))
        // The chat, as its detail comes back with the picture in its history.
        if (page.startsWith('/api/v2/chats/')) return json(200, egress({ success: true, data: { chat: { history: { messages: {
            m1: { response_id: 'r1', content: [{ type: 'image', image: { url: `${origin()}${PICTURE_PATH}` } }] }
        } } } } }))
        // The task, done — with the video.
        if (page.startsWith('/api/v1/tasks/status/')) return json(200, egress({ task_status: 'success', content: `${origin()}${VIDEO_PATH}` }))
        // An address nothing here answers is the scenario's mistake: said, and answered as a worker
        // that could not carry the call.
        failures.push(new Error(`nothing on the page answers ${body.method || 'GET'} ${page}`))
        return json(502, { code: 'page_fault', message: `nothing on the page answers ${body.method || 'GET'} ${page}` })
    }

    // The worker's streaming /egress: one JSON event per line, as the app reads them.
    async function relay(response, call) {
        const hold = state.hold
        state.hold = null
        const heldAfterHead = state.holdAfterHead
        state.holdAfterHead = false
        const answer = state.answer || TEXT_ANSWER
        state.answer = null
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
        // The app says "stop" by closing its side of the relay — which this stand-in does not
        // learn: it is served by Bun, and a server on Bun that has read the request body gets
        // no event and no flag when the client goes (2026-11-25, Bun 1.3.11 and 1.3.14). So
        // nothing here waits for it: the scenario alone lets the rest of the answer go, and a
        // scenario that gave up leaves the smoke without it. (When the hang-up itself must be
        // seen, the stand-in stands in a Node process — tools/client-gone-smoke.js.)
        event({
            type: 'head', status: 200, url: call.url, redirected: false,
            headers: { 'content-type': answer.type }, cookies: [cookie('cna', 'from-head')]
        })
        if (heldAfterHead) await new Promise(resolve => { releaseHeld = resolve })
        // The relay that was open when its account was forgotten: the page is gone, and its stream with it.
        if (heldAfterHead && forgotten.has(call.email)) {
            return response.end(`${JSON.stringify({ type: 'error', code: 'page_closed', message: 'The resident page was closed.' })}\n`)
        }
        // A relay asked for an account forgotten earlier is carried — as the worker of prod carries it
        // while the profile is kept (SIGNIN_FORGET_DELETES_PROFILE is off): it opens the page again from
        // the profile, and nothing in the application stops it but the guard (Qwen2API-u50). With the
        // profile deleted the worker answers 404 no_profile instead; that is not staged here.
        forgotten.delete(call.email)
        event({ type: 'chunk', data: Buffer.from(answer.pieces[0]).toString('base64') })
        // The answer's connection goes under it once it began (Qwen2API-jk9).
        const broke = state.breakRelay
        state.breakRelay = null
        if (broke) return response.end(`${JSON.stringify({ type: 'error', code: broke, message: `In-page fetch failed (${broke}).` })}\n`)
        await (hold || Promise.resolve())
        for (const piece of answer.pieces.slice(1)) event({ type: 'chunk', data: Buffer.from(piece).toString('base64') })
        response.end(`${JSON.stringify({ type: 'end', cookies: [cookie('ssxmod_itna', 'from-end')] })}\n`)
    }

    return {
        state, calls, direct, failures, puts, server,
        routes: () => calls.map(call => call.route),
        to: route => calls.filter(call => call.route === route).map(call => call.body),
        // Whether a relay is held after its head.
        held: () => Boolean(releaseHeld),
        // An address of the stand-in itself: where a link it hands out leads.
        asset: pathname => `${origin()}${pathname}`
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
    .filter(line => /v2 |V2SESSION|CHAT|chat creation|signin-worker|UPLOAD|Agent |MODULE_NOT_FOUND|upstream|Error/.test(line))
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
            QWEN_CLI_PROXY_URL: upstream,
            // A context over this goes up as a document (step 8). The smallest the setting takes
            // (its floor is 32 KiB); prod's is 90 KiB.
            AGENT_CONTEXT_FILE_THRESHOLD_BYTES: '32768'
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
        const whole = async (response, ms = 30000, message = 'the answer did not end in 30 s') => ({
            status: response.status, headers: response.headers, text: await within(response.text(), ms, message)
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

        // What the worker was asked since `from`: the route — and for a call of the page, its method and address.
        const trail = from => worker.calls.slice(from).map(call => call.route !== '/egress' ? call.route
            : `${call.body.method} ${new URL(call.body.url).pathname}${call.body.stream === true ? ' (stream)' : ''}`)

        // 4a. Since Qwen2API-jk9 (2026-11-27): a relay that fails once the answer is under way, on a request
        //     without a stream, is not the completions call's alone to make again — nothing has reached the
        //     client —: the application makes the whole request once more, a new chats/new included, and the
        //     client gets the second answer behind a 200.
        worker.state.answer = { type: 'text/event-stream', pieces: [frame({ phase: 'answer', content: 'Unfinished, and' }), REST] }
        worker.state.breakRelay = 'egress_failed'
        const beforeBreak = worker.calls.length
        const askedAgain = await whole(await chat(false))
        assert.equal(askedAgain.status, 200, `${askedAgain.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(askedAgain.text).choices[0].message.content, ANSWER, askedAgain.text)
        assert.deepEqual(trail(beforeBreak), [
            'POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)',
            'POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)'
        ], 'a chats/new, the relay that broke under its answer, and the whole request once more')
        assert.ok(!askedAgain.text.includes('Unfinished'), 'a byte of the answer that broke reached the client')
        // The application's last lines of a request can reach this pipe after its response reached the client.
        await wait(() => /非流式整体重试 \(原因: upstream_broke, egress_failed\)/.test(log()), 'the log does not say the request was made again, and why')
        await wait(() => /非流式整体重试成功 \(原因: upstream_broke, egress_failed\)/.test(log()), 'the log does not say the retried answer was delivered')
        console.log('PASS: browser mode — an answer whose connection went under it, on a request without a stream: the whole request is made once more, and the client gets the answer behind a 200')

        // 4b. A chats/new the page did not answer in time — the worker's 504 egress_timeout, answered here at
        //     once rather than thirty seconds on: the application waits two seconds and makes the whole request
        //     once more.
        worker.state.refuseChatsNew = 'egress_timeout'
        const beforeTimeout = worker.calls.length
        const askedLater = await whole(await chat(false))
        assert.equal(askedLater.status, 200, `${askedLater.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(askedLater.text).choices[0].message.content, ANSWER, askedLater.text)
        assert.deepEqual(trail(beforeTimeout), [
            'POST /api/v2/chats/new', 'POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)'
        ], 'the chats/new that timed out, then the whole request once more')
        // Between the chats/new the worker gave up on and the one after it. The floor leaves out what a timer
        // may fire short by and a clock tick: what it rules out is no pause, or a shorter one.
        const [timedOut, afterPause] = worker.calls.slice(beforeTimeout)
            .filter(call => call.route === '/egress' && new URL(call.body.url).pathname === '/api/v2/chats/new')
        const waited = afterPause.at - timedOut.at
        assert.ok(waited >= 1900, `the request was asked again ${waited} ms after the chats/new the worker gave up on`)
        await wait(() => /非流式整体重试 \(原因: chats_new_timeout\)/.test(log()), 'the log does not say the request was made again after the timed-out chats/new')
        await wait(() => /非流式整体重试成功 \(原因: chats_new_timeout\)/.test(log()), 'the log does not say the retried answer was delivered')
        console.log(`PASS: browser mode — a chats/new the worker gave up on: the whole request is made once more ${waited} ms later, ` +
            'and the client gets the answer behind a 200')

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

        // 7. One more start. Each recovery is its process's first: prod allows an account's page one
        //    reload in 30 seconds (V2_SESSION_RECOVERY_MIN_INTERVAL_MS), and step 6 has just had
        //    its — the step below needs one of its own. The session is read back from disk, as after step 5.
        const exitAfterChallenge = await stopApplication(application)
        if (process.platform !== 'win32') assert.equal(exitAfterChallenge, 0, 'SIGTERM should exit cleanly — the second launch')
        await start()
        await wait(() => /v2 会话恢复完成: 1 个有效/.test(log()), 'the session was not restored at the third start')
        assert.equal(worker.routes().filter(route => route === '/session').length, 1, 'the third start costs no password')
        console.log('PASS: browser mode — the session is back from disk for the steps below, with no sign-in')

        // 8. A file in the prompt (Qwen2API-3ue.11). upload.js takes browser-egress.js inside two
        //    functions — the token call and the parse — and both are run here, in the application
        //    as this run starts it. A prompt over the threshold, asked for with tools: a request
        //    that may not make do without the document.
        const DOCUMENT = 'The agent context of the smoke, long enough to go up as a document. '.repeat(600)
        const withTools = () => request('/v1/chat/completions', {
            method: 'POST', headers: jsonHeaders,
            body: JSON.stringify({
                model: MODEL, max_tokens: 32, stream: false, messages: [{ role: 'user', content: DOCUMENT }],
                tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }]
            })
        })
        // qwen.ai refuses the token call: the chat is made, the page is asked for the token once, and
        // the client's answer is a retryable 503. Nothing is uploaded.
        worker.state.answer = AGENT_ANSWER
        worker.state.answers[STS_PATH] = ['not-allowed']
        const beforeRefusal = worker.calls.length
        const refused = await whole(await withTools())
        assert.equal(refused.status, 503, `${refused.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(refused.text).error.code, 'upstream_unavailable', refused.text)
        assert.equal(refused.headers.get('retry-after'), '10', 'the client is told how long to wait')
        assert.deepEqual(trail(beforeRefusal), ['POST /api/v2/chats/new', `POST ${STS_PATH}`],
            'the chat, then one token call of the page: its refusal is not worth a retry')
        assert.equal(worker.puts.length, 0, 'a refused token call uploads nothing')
        console.log('PASS: browser mode — a token call qwen.ai refuses is the client\'s 503: asked of the page once, nothing uploaded')

        // The whole path. The parse is answered with a WAF challenge page once — as qwen.ai answered
        // the first parse of a document on 2026-11-26: one reload of the page, exactly one retry, and
        // no password. The status is asked for until the parse is done.
        worker.state.answer = AGENT_ANSWER
        worker.state.answers[PARSE_PATH] = ['challenge']
        worker.state.answers[PARSE_STATUS_PATH] = ['parsing']
        const beforeDocument = worker.calls.length
        const document = await whole(await withTools())
        assert.equal(document.status, 200, `${document.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(document.text).choices[0].message.content, ANSWER, document.text)
        assert.deepEqual(trail(beforeDocument), [
            'POST /api/v2/chats/new', `POST ${STS_PATH}`,
            `POST ${PARSE_PATH}`, '/renew', `POST ${PARSE_PATH}`,
            `POST ${PARSE_STATUS_PATH}`, `POST ${PARSE_STATUS_PATH}`,
            'POST /api/v2/chat/completions (stream)'
        ], 'the chat, the token of the page, the parse — challenged once, asked once more after a reload — its status until done, the answer through the relay')
        assert.equal(worker.to('/renew').at(-1).force, true, 'a challenge page is a forced reload')
        assert.match(log(), /v2 会话已续期 \([^)]*触发原因: upstream_waf_challenge\)/, 'the log does not say why the page was reloaded')
        // The bytes went to the storage the answer named — straight from the application, signed as
        // the page signs (Qwen2API-3ue.12): V4, in the region of the answer. The context is the one
        // the application builds for a request with tools: the prompt, under the protocol's own head.
        assert.equal(worker.puts.length, 1, 'the document is uploaded once')
        const [put] = worker.puts
        assert.ok(put.body.includes(DOCUMENT), 'the bytes carry the context')
        assert.equal(put.headers.host, `${BUCKET}.${REGION}.aliyuncs.com`, 'the bucket and the region the answer named')
        assert.equal(put.headers['x-oss-security-token'], SECURITY_TOKEN)
        assert.match(String(put.headers.authorization),
            new RegExp(`^OSS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/\\d{8}/smoke-1/oss/aliyun_v4_request(,AdditionalHeaders=[^,]+)?,Signature=[0-9a-f]{64}$`),
            'signed V4, in the region the answer named')
        // The token call of the page: the page's own body — the size of what was uploaded, as a
        // string — and no Bearer.
        const tokenCall = worker.to('/egress').filter(call => new URL(call.url).pathname === STS_PATH).at(-1)
        const asked = JSON.parse(tokenCall.body)
        assert.match(asked.filename, /^QWEN2API_AGENT_CONTEXT_\d+\.txt$/)
        assert.deepEqual([asked.filesize, asked.filetype], [String(Buffer.byteLength(put.body)), 'file'],
            'the body the page sends: the size as a string')
        assert.ok(!('authorization' in tokenCall.headers), 'the token call carries no Bearer (Qwen2API-jr9)')
        // And the generation qwen.ai is asked for carries the document it parsed.
        const generation = JSON.parse(worker.to('/egress').filter(call => call.stream === true).at(-1).body)
        assert.deepEqual(generation.messages[0].files.map(file => [file.id, file.url]), [[FILE_ID, worker.asset(`/${FILE_PATH}`)]],
            'the parsed document is not in the request made of the page')
        console.log('PASS: browser mode — a file in the prompt: the token of the page, the bytes to the storage the answer named, the parse by the page — a challenge page on it is one reload and one retry')

        // 9. An image, generated through the page: one chats/new, one relay — the fetch of the page's
        //    own — with the link in its answer. The application fetches the picture itself, straight
        //    from where the link leads: the CDN is not qwen.ai.
        worker.state.answer = pictureAnswer(worker.asset(PICTURE_PATH))
        const beforeImage = worker.calls.length
        const directBeforeImage = worker.direct.length
        const image = await whole(await request('/v1/images/generations', {
            method: 'POST', headers: jsonHeaders,
            body: JSON.stringify({ model: MODEL, prompt: 'a smoke picture', response_format: 'b64_json' })
        }))
        assert.equal(image.status, 200, `${image.text}\n${evidence(application.logs)}`)
        // The bytes the client gets are the ones behind the link.
        assert.deepEqual(Buffer.from(JSON.parse(image.text).data[0].b64_json, 'base64'), PICTURE_BYTES)
        assert.deepEqual(trail(beforeImage), ['POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)'],
            'one chats/new and one generation through the relay; the link is in the answer, so the chat is not looked up')
        assert.deepEqual(worker.direct.slice(directBeforeImage), [`GET ${PICTURE_PATH}`], 'the picture is fetched from where its link leads')
        const imageGeneration = worker.calls.slice(beforeImage)[1].body
        assert.equal(imageGeneration.url, `${upstream}/api/v2/chat/completions?chat_id=smoke-browser-image-${worker.state.chats.t2i}`)
        assert.equal(JSON.parse(imageGeneration.body).messages[0].chat_type, 't2i')
        assert.equal(JSON.parse(imageGeneration.body).stream, true, 'the generation is the page\'s own fetch: a stream')
        console.log('PASS: browser mode — an image is generated through the relay, and its link, out of the answer, is fetched directly')

        // 10. The link is not in the answer: it is looked up in the chat — through the page, as a whole answer.
        worker.state.answer = NO_LINK_ANSWER
        const beforeLookup = worker.calls.length
        const directBeforeLookup = worker.direct.length
        const lookedUp = await whole(await request('/v1/images/generations', {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: MODEL, prompt: 'another smoke picture' })
        }))
        assert.equal(lookedUp.status, 200, `${lookedUp.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(lookedUp.text).data[0].url, worker.asset(PICTURE_PATH))
        const secondGeneration = worker.calls.slice(beforeLookup)[1].body
        const chatOf = new URL(secondGeneration.url).searchParams.get('chat_id')
        assert.notEqual(chatOf, new URL(imageGeneration.url).searchParams.get('chat_id'), 'a generation gets a chat of its own')
        assert.deepEqual(trail(beforeLookup), ['POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)', `GET /api/v2/chats/${chatOf}`],
            'the link is looked up in the chat the picture was generated in, through the page')
        assert.deepEqual(worker.direct.slice(directBeforeLookup), [], 'a link the client is only given is fetched by nobody')
        console.log('PASS: browser mode — an image whose link is not in the answer is looked up in the chat through the page')

        // 11. A video: the relay's answer is JSON, read whole — a task to poll. The task is asked for
        //     through the page, and answers done at once. (A poll that is not done waits the task's
        //     twenty seconds for the next one: tests/browser-egress.test.js holds that.)
        worker.state.answer = TASK_ANSWER
        const beforeVideo = worker.calls.length
        const video = await whole(await request('/v1/videos', {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: MODEL, prompt: 'a smoke video' })
        }), 15000, 'the video did not come in 15 s: its task answers done at the first poll, and nothing here waits for a second')
        assert.equal(video.status, 200, `${video.text}\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(video.text).data[0].url, worker.asset(VIDEO_PATH))
        assert.deepEqual(trail(beforeVideo), [
            'POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)', `GET /api/v1/tasks/status/${VIDEO_TASK}`
        ], 'one chats/new, the generation through the relay, one poll of the task through the page')
        const videoGeneration = JSON.parse(worker.calls.slice(beforeVideo)[1].body.body)
        // The video's body asks qwen.ai for no stream; the call is the page's fetch all the same.
        assert.deepEqual([videoGeneration.messages[0].chat_type, videoGeneration.stream], ['t2v', false])
        assert.equal(worker.calls.at(-1).body.url, `${upstream}/api/v1/tasks/status/${VIDEO_TASK}`)
        console.log('PASS: browser mode — a video is generated through the relay, its answer read whole, and its task polled through the page')

        // 12. An account is removed while its request still waits for qwen.ai's first frame. The worker
        //     is told once — POST /forget, on the worker's token (Qwen2API-2l0) — and the page's stream is
        //     cut with the page. The request's retry does not reach the worker for the account that is
        //     gone (Qwen2API-u50): no second /egress, no /renew, no /session; the client gets an error it
        //     may retry, not a cut answer behind a 200.
        //     The stand-in cuts the stream the moment it is told. The worker of prod waits for the streams
        //     on a page first (RESIDENT_STREAM_WAIT_MS, 20 s), and a stream that gets its frames meanwhile
        //     ends whole; what is staged here is the cut that lands before the first frame — a short wait,
        //     or a page that died — which is the one whose retry would have brought the account back.
        //     A relay asked for the account after the /forget is carried as the worker of prod carries it
        //     with the profile kept: the page is opened again. Without the guard the retry is answered —
        //     the client gets the answer of an account the application has removed, behind a 200.
        worker.state.holdAfterHead = true
        const beforeRemoval = worker.calls.length
        const cutting = chat(true, 'Reply OK.')
        // Its outcome is read below, once the account is removed: a rejection before that must not end the smoke.
        cutting.catch(() => {})
        await wait(() => worker.held(), 'the relay did not come to its hold after the head')
        const heldAt = Date.now()
        // Well inside the application's grace for the first frame: past it the stream is handed to the client as it is.
        const removal = await whole(await request('/api/deleteAccount', {
            method: 'DELETE', headers: jsonHeaders, body: JSON.stringify({ email: EMAIL })
        }), 15000, 'the removal did not answer in 15 s')
        assert.equal(removal.status, 200, `${removal.text}\n${evidence(application.logs)}`)
        assert.deepEqual(worker.to('/forget'), [{ email: EMAIL }], 'the worker was told of the removal once, about that account alone')
        assert.equal(worker.calls.at(-1).authorized, true, '/forget carries SIGNIN_WORKER_TOKEN')
        const cut = await whole(await within(cutting, 15000, 'the request whose account was removed did not answer in 15 s'), 15000,
            'the request whose account was removed did not end in 15 s')
        // A retryable error, and the one the request's own failure answers with — not a cut answer behind a 200.
        // (Had the removal come later than the application's 3 s of grace for the first frame, the stream
        // would have been handed to the client as it was, and the status would read 200.)
        const toldAfterMs = Date.now() - heldAt
        assert.equal(cut.status, 503,
            `the request of the removed account did not end in the error it should — it was carried after the removal: ` +
            `${cut.status} ${cut.text}; the worker was told ${toldAfterMs} ms after the relay's head\n${evidence(application.logs)}`)
        assert.equal(JSON.parse(cut.text).error?.code, 'upstream_error', cut.text)
        assert.equal(cut.text.includes(ANSWER), false, 'a cut answer reached the client')
        // The application's last lines of the request can reach this pipe after its response reaches the
        // client (seen on the Windows runner of CI): they are waited for, a while, not read at once.
        await wait(() => /signin-worker 已忘掉账户/.test(log()) && /account_removed/.test(log()),
            "the application does not say that the worker forgot the account and refused the retry as the account's being removed")
        assert.match(log(), /signin-worker 已忘掉账户/, 'the application does not say the worker forgot the account')
        assert.match(log(), /account_removed/, "the request's retry was not refused as the account's being removed")
        // What the application does of the failure takes its time: give a delayed call its chance to show.
        await delay(1500)
        assert.deepEqual(trail(beforeRemoval), [
            'POST /api/v2/chats/new', 'POST /api/v2/chat/completions (stream)', '/forget'
        ], 'after the /forget nothing of the account reached the worker: no second relay, no renewal, no sign-in')
        const left = await (await request('/api/getAllAccounts', { headers: { 'x-api-key': API_KEY } })).json()
        assert.deepEqual(left.data, [], 'the account is gone from the application')
        console.log('PASS: browser mode — an account removed mid-request: the worker is told once, and the request\'s retry does not reach it for that account')

        // 13. What left for qwen.ai, and how.
        assert.equal(worker.failures.length, 0, `the stand-in failed: ${worker.failures[0]?.message}`)
        assert.equal(worker.routes().filter(route => route === '/session').length, 1, 'a challenge costs no password')
        assert.ok(worker.calls.every(call => call.authorized), 'every worker call carries SIGNIN_WORKER_TOKEN')
        assert.ok(worker.to('/egress').every(call => call.email === EMAIL), 'every call left from the account\'s page')
        assert.ok(worker.to('/egress').every(call => !('authorization' in call.headers)),
            'the app put a Bearer of its own on an egress call (Qwen2API-jr9)')
        assert.ok(worker.to('/egress').every(call => new URL(call.url).origin === upstream),
            'a call of the page left for somewhere else than the address the application has for qwen.ai')
        // Straight from the application went the model list, and the two that are not qwen.ai: the
        // file's bytes and the picture. Chats, completions, the token, the parse, the chat and the
        // task reached qwen.ai through the page only.
        assert.deepEqual(worker.direct.filter(line => line !== 'GET /api/models'), [`PUT /${FILE_PATH}`, `GET ${PICTURE_PATH}`],
            'straight from the application went something else than the model list, the file\'s bytes and the picture')
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
        // Not a check: a directory Windows still holds is left, and said — not failed over (Qwen2API-3ue.13).
        await discardTemporaryDirectory(temporaryDirectory)
    }
}

module.exports = run
