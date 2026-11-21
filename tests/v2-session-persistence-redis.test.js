// Redis backend for v2 session persistence (Qwen2API-jik.4). ioredis is
// stubbed at module level (same pattern as account-deletion-redis.test.js):
// the hash lives in a plain Map, values are stored as the exact strings the
// real client would see.
process.env.DATA_SAVE_MODE = 'redis'
process.env.REDIS_URL = 'redis://127.0.0.1:6379'
process.env.V2_SESSION_MODE = 'browser'
process.env.QWEN_CHAT_PROXY_URL = 'https://chat.qwen.ai'
process.env.API_KEY = 'v2-persist-redis-test'
process.env.ENABLE_FILE_LOG = 'false'
process.env.ENABLE_CLI = 'false'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { CookieJar } = require('tough-cookie')

const hashStore = new Map()
class FakeRedis extends EventEmitter {
    constructor() { super(); this.status = 'wait' }
    async connect() { this.status = 'ready'; this.emit('ready') }
    async ping() { return 'PONG' }
    async hset(key, field, value) {
        // ioredis accepts both hset(key, field, value) and hset(key, {field: value})
        const fields = value === undefined ? field : { [field]: value }
        hashStore.set(key, { ...(hashStore.get(key) || {}), ...fields })
        return 1
    }
    async hgetall(key) { return { ...(hashStore.get(key) || {}) } }
    async hdel(key, ...fields) {
        const hash = { ...(hashStore.get(key) || {}) }
        let removed = 0
        for (const field of fields) if (field in hash) { delete hash[field]; removed++ }
        hashStore.set(key, hash)
        return removed
    }
    async del(key) { return Number(hashStore.delete(key)) }
    async scan(cursor) { return ['0', [...hashStore.keys()]] }
    disconnect() { this.status = 'end'; this.emit('end') }
}
const redisPath = require.resolve('ioredis')
const redisStub = new Module(redisPath)
redisStub.filename = redisPath; redisStub.loaded = true; redisStub.exports = FakeRedis
require.cache[redisPath] = redisStub

// Renewal flows belong to the file-backend suite; here the worker only needs
// to exist so module load does not reach for a real sidecar.
const workerPath = require.resolve('../src/utils/signin-worker-client')
const workerStub = new Module(workerPath)
workerStub.filename = workerPath; workerStub.loaded = true
workerStub.exports = {
    renewSession: async () => { throw new Error('not used in the redis suite') },
    acquireSession: async () => { throw new Error('not used in the redis suite') }
}
require.cache[workerPath] = workerStub

const redis = require('../src/utils/redis')
const persistenceModule = require('../src/utils/v2-session-persistence')
const store = require('../src/utils/v2-session-store')

test.after(async () => { await redis.cleanup() })
test.beforeEach(() => { hashStore.clear(); store.clearSessions() })

const SESSIONS_KEY = 'qwen2api:v2sessions'
const tokenWith = (exp) =>
    'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'x', exp })).toString('base64url') + '.fixture'
const jarWith = (value = 'restored=yes') => {
    const jar = new CookieJar()
    jar.setCookieSync(`${value}; Domain=.qwen.ai; Path=/; Secure`, 'https://chat.qwen.ai/')
    return jar
}

test('sessions live in a dedicated hash outside the user:* account scan, token stored as JSON', async () => {
    const email = 'hashed@example.invalid'
    const token = tokenWith(Math.floor(Date.now() / 1000) + 1800)
    const saved = await persistenceModule.publishSession(email, { token, expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith('redis=1') })
    assert.equal(saved, true)
    assert.ok(store.sessionFor(email, token))

    assert.deepEqual([...hashStore.keys()], [SESSIONS_KEY], 'no user: key is created for a session')
    const raw = hashStore.get(SESSIONS_KEY)[email]
    assert.equal(typeof raw, 'string', 'field value is a JSON string, like real Redis')
    const record = JSON.parse(raw)
    assert.equal(record.token, token)
    assert.equal(record.jar.cookies[0].key, 'redis')
    assert.equal(record.jar.cookies[0].value, '1', 'jar is serialized inside the record')
})

test('load round-trips through HGETALL and delete removes only the targeted field', async () => {
    const persistence = persistenceModule.persistence
    await persistence.saveV2Session('a@example.invalid', { token: 'ta', expiresAt: 2, jar: { cookies: [] } })
    await persistence.saveV2Session('b@example.invalid', { token: 'tb', expiresAt: 3, jar: { cookies: [] } })
    const loaded = await persistence.loadV2Sessions()
    assert.deepEqual(Object.keys(loaded).sort(), ['a@example.invalid', 'b@example.invalid'])
    assert.equal(loaded['a@example.invalid'].token, 'ta')

    assert.equal(await persistence.deleteV2Session('a@example.invalid'), true)
    assert.deepEqual(Object.keys(await persistence.loadV2Sessions()), ['b@example.invalid'])
    assert.equal(await persistence.deleteV2Session('missing@example.invalid'), true, 'delete is idempotent')
})

test('a malformed field never breaks the load — it is skipped, the rest survives', async () => {
    const persistence = persistenceModule.persistence
    await persistence.saveV2Session('good@example.invalid', { token: 'tg', expiresAt: 9, jar: { cookies: [] } })
    hashStore.get(SESSIONS_KEY)['bad@example.invalid'] = '{not json'
    const loaded = await persistence.loadV2Sessions()
    assert.deepEqual(Object.keys(loaded), ['good@example.invalid'])
})

test('restoreSessions revives the live record and prunes the expired one out of Redis', async () => {
    const live = 'live@example.invalid', dead = 'dead@example.invalid'
    const liveToken = tokenWith(Math.floor(Date.now() / 1000) + 1800)
    await persistenceModule.publishSession(live, { token: liveToken, expiresAt: Math.floor(Date.now() / 1000) + 1800, jar: jarWith('live=1') })
    await persistenceModule.persistence.saveV2Session(dead, { token: tokenWith(1), expiresAt: 1, jar: jarWith().toJSON() })

    store.clearSessions()
    assert.equal(await persistenceModule.restoreSessions(), 1)
    const session = store.sessionFor(live, liveToken)
    assert.ok(session)
    assert.deepEqual(session.jar.getCookiesSync('https://chat.qwen.ai/x').map(cookie => cookie.cookieString()), ['live=1'])
    assert.equal(store.sessionFor(dead, 'any'), null)
    assert.deepEqual(Object.keys(hashStore.get(SESSIONS_KEY)), [live], 'expired record was HDEL-ed')
})

test('deleting an account removes its user hash AND its session field; a late save cannot resurrect it', async () => {
    const persistence = persistenceModule.persistence
    const email = 'removed@example.invalid'
    assert.equal(await persistence.saveAccount(email, { password: 'pw', token: tokenWith(Math.floor(Date.now() / 1000) + 1800) }, { allowCreate: true }), true)
    await persistence.saveV2Session(email, { token: tokenWith(Math.floor(Date.now() / 1000) + 1800), expiresAt: 1, jar: { cookies: [] } })

    assert.equal(await persistence.deleteAccount(email), true)
    assert.equal(hashStore.has(`user:${email}`), false)
    assert.equal(email in (hashStore.get(SESSIONS_KEY) || {}), false, 'session field gone with the account')

    assert.equal(await persistence.saveV2Session(email, { token: 'ghost', expiresAt: 1, jar: { cookies: [] } }), false,
        'the deleted-account guard refuses to write a session back')
})
