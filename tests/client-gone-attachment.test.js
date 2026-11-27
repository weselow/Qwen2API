const test = require('node:test')
const assert = require('node:assert/strict')
const OSS = require('ali-oss')

// A client that goes away while a file is being attached to its request
// (Qwen2API-4l1). The closing of an upstream a client left used to begin with
// the completions call (Qwen2API-3ue.10); what precedes it went on to the end:
// a picture in a message — the token call and the upload to OSS —, a document
// in the prompt — the same, then the parse and its status polls —, and the
// chat's creation before either. There is no stream to close there: what can
// be done is not to begin the next step, and to end a pause at once.
// The client is what watchClient(req) returns, made to leave when a test says
// so; the token call, the parse and its polls are an axios stand-in, the
// upload an OSS stand-in. Nothing reaches qwen.ai.
process.env.API_KEY = 'client-gone-attachment-test'
process.env.ENABLE_FILE_LOG = 'false'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
// The direct road: no page, no worker.
delete process.env.V2_SESSION_MODE
delete process.env.SIGNIN_WORKER_URL
delete process.env.QWEN_LAB_V2_AUTH_ORIGIN

const held = { sts: [], chats: [], parse: [] }
const mode = { holdSts: false, holdChats: false, holdParse: false }
const calls = []
let statusQueue = []
const stsAnswer = () => ({
    status: 200,
    data: {
        access_key_id: 'test-access-key',
        access_key_secret: 'test-access-secret',
        security_token: 'test-security-token',
        file_url: 'https://example.invalid/upload.png',
        file_path: 'test/upload.png',
        bucketname: 'upload-test',
        region: 'oss-cn-hangzhou',
        file_id: 'upload-file'
    }
})
const pending = () => ({ data: { success: true, data: { list: [{ file_id: 'f1', status: 'parsing' }] } } })
const announce = {}
const axiosStub = {
    request: async () => ({ status: 200, headers: { toJSON: () => ({}) }, data: Buffer.from('upload response') }),
    post: async (url, data) => {
        calls.push(url)
        if (url.endsWith('/api/v1/files/getstsToken')) {
            if (mode.holdSts) {
                const answer = new Promise((resolve, reject) => { held.sts.push({ resolve, reject }) })
                announce.sts?.()
                return answer
            }
            return stsAnswer()
        }
        if (url.endsWith('/api/v2/chats/new')) {
            let finish
            const answer = new Promise((resolve, reject) => { finish = resolve; held.chats.push({ resolve, reject }) })
            if (!mode.holdChats) finish({ status: 200, data: { success: true, data: { id: 'chat-1' } } })
            announce.chats?.()
            return answer
        }
        if (url.endsWith('/api/v2/files/parse')) {
            if (mode.holdParse) {
                const answer = new Promise((resolve, reject) => { held.parse.push({ resolve, reject }) })
                announce.parse?.()
                return answer
            }
            return { data: { success: true, data: {} } }
        }
        if (url.endsWith('/api/v2/files/parse/status')) return statusQueue.length > 1 ? statusQueue.shift() : (statusQueue[0] || pending())
        throw new Error(`unexpected axios.post ${url}`)
    },
    get: async (url) => { throw new Error(`unexpected axios.get ${url}`) },
    create() { return axiosStub },
    defaults: { headers: { common: {} } },
    isAxiosError: () => false
}
axiosStub.default = axiosStub
const axiosPath = require.resolve('axios')
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub }

const uploadModule = require('../src/utils/upload.js')
const { parserMessages, imgCacheManager } = require('../src/utils/chat-helpers.js')
const { sendChatRequest, externalizeOversizedAgentContext } = require('../src/utils/request.js')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const { handleOpenAIImagesEdit } = require('../src/controllers/chat.image.video.js')
const { EventEmitter } = require('node:events')
const accountManager = require('../src/utils/account.js')
const { ClientGoneError, isClientGone } = require('../src/utils/client-gone.js')
const { logger } = require('../src/utils/logger')

test.before(async () => { await accountManager._initPromise; accountManager.destroy() })

// A client as watchClient(req) makes it; `leave()` is its client going away.
const clientOf = () => {
    let gone = false
    const handlers = new Set()
    return {
        gone: () => gone,
        onGone: handler => {
            if (gone) { handler(); return () => {} }
            handlers.add(handler)
            return () => handlers.delete(handler)
        },
        leave: () => {
            gone = true
            for (const handler of [...handlers]) handler()
        }
    }
}

// What the app says while a test runs: a client's going is said by nobody.
function quiet(t) {
    const said = []
    const saved = { error: logger.error, warn: logger.warn }
    logger.error = (...args) => { said.push(args.join(' ')) }
    logger.warn = (...args) => { said.push(args.join(' ')) }
    t.after(() => Object.assign(logger, saved))
    return said
}

// Nothing a test waits for may keep it for ever.
const within = (pending, ms = 5000, what = 'it') => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`${what} did not happen in ${ms} ms`)), ms)
    Promise.resolve(pending).then(value => { clearTimeout(guard); resolve(value) }, error => { clearTimeout(guard); reject(error) })
})

async function until(condition, timeoutMs = 5000, what = 'condition') {
    if (typeof timeoutMs !== 'number') throw new TypeError(`until(condition, timeoutMs, what): the second argument is the timeout in ms, got ${typeof timeoutMs}`)
    const deadline = Date.now() + timeoutMs
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`${what} not met in ${timeoutMs} ms`)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

// The stand-ins as a test finds them: nothing held, nothing asked, the OSS stand-in counting.
async function withUpload(t) {
    const counts = { oss: 0 }
    const put = OSS.prototype.put
    OSS.prototype.put = async function () { counts.oss++; return { res: { status: 200 } } }
    t.after(() => { OSS.prototype.put = put })
    calls.length = 0
    for (const key of Object.keys(held)) held[key].length = 0
    for (const key of Object.keys(mode)) mode[key] = false
    statusQueue = []
    imgCacheManager.clear()
    const of = suffix => calls.filter(url => url.endsWith(suffix)).length
    return {
        counts,
        sts: () => of('/api/v1/files/getstsToken'),
        oss: () => counts.oss,
        parse: () => of('/api/v2/files/parse'),
        polls: () => of('/api/v2/files/parse/status'),
        chats: () => of('/api/v2/chats/new'),
        // What the held request of a road is answered with.
        answer: async (road, value) => {
            const request = held[road].shift()
            assert.ok(request, `no ${road} request is held`)
            request.resolve(value)
        }
    }
}

// Resolves once the held request of a road is at the stand-in. Taken before the operation
// runs: an operation reaches its stand-in before it ever awaits.
const reached = road => new Promise(resolve => { announce[road] = resolve })

const IMAGE = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('a picture of a cat').toString('base64')}` } }] }]
const ACCOUNT = { email: 'attachment@example.invalid', token: 'synthetic-token', password: 'synthetic', proxy: null }

test('a picture in a message: gone before its upload — the token call is not made', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const client = clientOf()
    client.leave()
    await assert.rejects(parserMessages(IMAGE, {}, 't2t', () => ACCOUNT, client), error => error instanceof ClientGoneError)
    assert.deepEqual([u.sts(), u.oss()], [0, 0])
    assert.deepEqual(said, [])
})

test('a file: gone before its upload — the uploader asks for no token, whichever road called it', { timeout: 15000 }, async t => {
    // The uploader's own asking, apart from the ones of the roads that lead to it.
    const u = await withUpload(t)
    const client = clientOf()
    client.leave()
    await assert.rejects(uploadModule.uploadFileToQwenOss(Buffer.from('bytes'), 'a.txt', 'synthetic-token', ACCOUNT, { client }),
        error => error instanceof ClientGoneError)
    assert.deepEqual([u.sts(), u.oss()], [0, 0])
})

test('a picture in a message: gone before its upload — the uploader is not called', { timeout: 15000 }, async t => {
    // The message's own asking, apart from the uploader's.
    await withUpload(t)
    const upload = uploadModule.uploadFileToQwenOss
    const uploads = []
    uploadModule.uploadFileToQwenOss = async (...args) => { uploads.push(args); return { status: 200, file_url: 'https://example.invalid/a.png', file_id: 'f1' } }
    t.after(() => { uploadModule.uploadFileToQwenOss = upload })
    const client = clientOf()
    client.leave()
    await assert.rejects(parserMessages(IMAGE, {}, 't2t', () => ACCOUNT, client), error => error instanceof ClientGoneError)
    assert.deepEqual(uploads, [])
})

test('a picture in a message: gone while the token call is out — the bytes are not sent, and nothing is said', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const client = clientOf()
    mode.holdSts = true
    const atSts = reached('sts')
    const parsing = parserMessages(IMAGE, {}, 't2t', () => ACCOUNT, client)
    await within(atSts, 5000, 'the token call reaching the stand-in')
    client.leave()
    await u.answer('sts', stsAnswer())
    await assert.rejects(parsing, error => {
        assert.equal(isClientGone(error), true)
        return true
    })
    assert.deepEqual([u.sts(), u.oss()], [1, 0], 'the token was asked for, the bytes were not sent')
    assert.deepEqual(said, [], 'the going is no failure of the upload')
})

test('a picture in a message: a client that stays gets its picture uploaded, as before', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const parsed = await parserMessages(IMAGE, {}, 't2t', () => ACCOUNT, clientOf())
    assert.deepEqual([u.sts(), u.oss()], [1, 1], said.join(' | '))
    assert.deepEqual(said, [])
    assert.match(JSON.stringify(parsed), /example\.invalid\/upload\.png/)
    // And one that brings no client at all reads as it always did.
    const other = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,RklGUVVJ' } }] }]
    const plain = await parserMessages(other, {}, 't2t', () => ACCOUNT)
    assert.equal(u.oss(), 2)
    assert.match(JSON.stringify(plain), /upload\.png/)
})

test('a document in the prompt: gone before the parse — it is not asked for', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const client = clientOf()
    client.leave()
    await assert.rejects(uploadModule.parseUploadedTextFile('f1', 'synthetic-token', ACCOUNT, { client }), error => error instanceof ClientGoneError)
    assert.deepEqual([u.parse(), u.polls()], [0, 0])
})

test('a document in the prompt: gone while the parse is out — its status is not polled, and nothing is said', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const client = clientOf()
    mode.holdParse = true
    const atParse = reached('parse')
    const parsing = uploadModule.uploadAgentContextFile('the whole story of the request, as text', 'synthetic-token', ACCOUNT, { client })
    await within(atParse, 5000, 'the parse reaching the stand-in')
    client.leave()
    await u.answer('parse', { data: { success: true, data: {} } })
    await assert.rejects(parsing, error => {
        assert.equal(isClientGone(error), true)
        return true
    })
    assert.deepEqual([u.parse(), u.polls()], [1, 0], 'the parse was asked for once, its status never')
    assert.deepEqual(said, [], 'the going is no failure of the parse')
})

test('a document in the prompt: gone between two polls — the pause ends at once, and no poll follows', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const client = clientOf()
    statusQueue = [pending()]
    const before = Date.now()
    const parsing = uploadModule.parseUploadedTextFile('f1', 'synthetic-token', ACCOUNT, { client, intervalMs: 5000, maxAttempts: 30 })
    parsing.catch(() => {})
    await until(() => u.polls() === 1, 5000, 'the first poll')
    client.leave()
    await assert.rejects(parsing, error => error instanceof ClientGoneError)
    assert.equal(Date.now() - before < 3000, true, 'the pause did not run its five seconds')
    assert.equal(u.polls(), 1, 'no second poll')
})

test('a document in the prompt: a client that stays is polled to the end, as before', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    statusQueue = [pending(), pending(), { data: { success: true, data: { list: [{ file_id: 'f1', status: 'success' }] } } }]
    assert.equal(await uploadModule.parseUploadedTextFile('f1', 'synthetic-token', ACCOUNT, { client: clientOf(), intervalMs: 10 }), true)
    assert.equal(u.polls(), 3)
})

test('the chat: gone before it is made — no chats/new; gone while it was being made — nothing is attached, nothing is said', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const big = 'x'.repeat(64 * 1024)
    const body = { model: 'qwen', messages: [{ role: 'user', content: big }] }
    const original = accountManager.accountTokens
    t.after(() => { accountManager.accountTokens = original; accountManager.accountRotator.setAccounts(original) })

    const goneBefore = clientOf()
    goneBefore.leave()
    await assert.rejects(sendChatRequest(body, { currentAccount: ACCOUNT, client: goneBefore }), error => error instanceof ClientGoneError)
    assert.deepEqual([u.chats(), u.sts()], [0, 0], 'no chat was made for a client that left')

    mode.holdChats = true
    const client = clientOf()
    const atChats = reached('chats')
    const sending = sendChatRequest(body, { currentAccount: ACCOUNT, client })
    sending.catch(() => {})
    await within(atChats, 5000, 'the chat’s creation reaching the stand-in')
    client.leave()
    await u.answer('chats', { status: 200, data: { success: true, data: { id: 'chat-1' } } })
    await assert.rejects(sending, error => {
        assert.equal(isClientGone(error), true)
        return true
    })
    // The empty chat was made — it stays in the account's history, as one does that is created before an attachment fails.
    assert.deepEqual([u.chats(), u.sts(), u.parse()], [1, 0, 0], 'and nothing was attached to it')
    assert.deepEqual(said, [], 'the going is no failure of the request')
})

test('the attachment of a context: gone already — the uploader is not called, whoever it is', { timeout: 15000 }, async t => {
    const client = clientOf()
    client.leave()
    const uploads = []
    const payload = { messages: [{ role: 'user', content: 'x'.repeat(64 * 1024) }] }
    await assert.rejects(externalizeOversizedAgentContext(payload, 'synthetic-token', ACCOUNT, {
        uploader: async (...args) => { uploads.push(args); return {} }, thresholdBytes: 1024, client
    }), error => error instanceof ClientGoneError)
    assert.deepEqual(uploads, [])
    // One that stays goes on to its uploader, as before.
    let keptUploads = 0
    const kept = await externalizeOversizedAgentContext(payload, 'synthetic-token', ACCOUNT, {
        uploader: async () => { keptUploads++; return { file_id: 'f1', file_url: 'https://example.invalid/f1.txt', name: 'context.txt' } },
        thresholdBytes: 1024, client: clientOf()
    })
    assert.deepEqual([kept.externalized, keptUploads], [true, 1])
})

test('/v1/images/edits: gone while the picture’s token call is out — the bytes are not sent, no generation, nothing is said', { timeout: 15000 }, async t => {
    const u = await withUpload(t)
    const said = quiet(t)
    const original = accountManager.accountTokens
    const initialized = accountManager.isInitialized
    // The account is the manager's own here, as an edit's picture is uploaded from the account the
    // request names — one the rotator takes: a token that decodes.
    const HELD = { ...ACCOUNT, token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature` }
    accountManager.accountTokens = [HELD]
    accountManager.accountRotator.setAccounts([HELD])
    accountManager.isInitialized = true
    t.after(() => {
        accountManager.accountTokens = original
        accountManager.accountRotator.setAccounts(original)
        accountManager.isInitialized = initialized
    })
    // A request as the handler gets it, and its client going as Bun reports it: the socket loses its address.
    let address = { address: '127.0.0.1', family: 'IPv4', port: 42424 }
    const socket = Object.assign(new EventEmitter(), { destroyed: false, address: () => address })
    const req = Object.assign(new EventEmitter(), {
        socket, aborted: false,
        body: { model: 'qwen3-max', prompt: 'make it red', image: `data:image/png;base64,${Buffer.from('a cat').toString('base64')}` }
    })
    const res = {
        statusCode: 200, body: null, headersSent: false,
        status(code) { this.statusCode = code; return this },
        json(payload) { this.body = payload; this.headersSent = true; return this },
        set() { return this }, write() { return true }, end() { this.headersSent = true }, on() { return this }
    }

    mode.holdSts = true
    const atSts = reached('sts')
    const editing = handleOpenAIImagesEdit(req, res).catch(error => ({ error }))
    await within(atSts, 5000, 'the token call reaching the stand-in')
    address = null
    await u.answer('sts', stsAnswer())
    const outcome = await within(editing, 10000, 'the edit')

    assert.equal(outcome, undefined, 'the request was ended for the client, not thrown out of the handler')
    // The token was asked for; the bytes were not sent, and no chat was made for the generation.
    assert.deepEqual([u.sts(), u.oss(), u.chats()], [1, 0, 0])
    assert.deepEqual([said, res.statusCode, res.body], [[], 200, null])
})
