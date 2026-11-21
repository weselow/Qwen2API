process.env.DATA_SAVE_MODE = 'redis'
process.env.REDIS_URL = 'redis://127.0.0.1:6379'
process.env.API_KEY = 'redis-deletion-test-key'
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const store = new Map()
let delError = null
class FakeRedis extends EventEmitter {
  constructor() { super(); this.status = 'wait' }
  async connect() { this.status = 'ready'; this.emit('ready') }
  async ping() { return 'PONG' }
  async hset(key, payload) { store.set(key, { ...store.get(key), ...payload }); return 1 }
  async del(key) { if (delError) throw delError; return Number(store.delete(key)) }
  async quit() { this.disconnect(); return 'OK' }
  disconnect() { this.status = 'end'; this.emit('end') }
}
const redisPath = require.resolve('ioredis')
const stub = new Module(redisPath)
stub.filename = redisPath; stub.loaded = true; stub.exports = FakeRedis
require.cache[redisPath] = stub
const DataPersistence = require('../src/utils/data-persistence')
const redis = require('../src/utils/redis')
test.after(async () => { await redis.cleanup() })

test('Redis deletion uses the account key, is idempotent and keeps unrelated keys', async () => {
  const persistence = new DataPersistence()
  store.set('user:delete@example.invalid', { token: 'synthetic' })
  store.set('user:keep@example.invalid', { token: 'keep' })
  store.set('qwen2api:settings', { json: '{"keep":true}' })
  assert.equal(await persistence.deleteAccount('delete@example.invalid'), true)
  assert.equal(store.has('user:delete@example.invalid'), false)
  assert.deepEqual(store.get('user:keep@example.invalid'), { token: 'keep' })
  assert.deepEqual(store.get('qwen2api:settings'), { json: '{"keep":true}' })
  assert.equal(await persistence.deleteAccount('delete@example.invalid'), true)
  assert.equal(await persistence.saveAccount('delete@example.invalid', { stats: { old: true } }), false)
  assert.equal(store.has('user:delete@example.invalid'), false)
  assert.equal(await persistence.saveAccount('delete@example.invalid', { token: 'new' }, { allowCreate: true }), true)
  assert.equal(store.get('user:delete@example.invalid').token, 'new')
})

test('Redis failure keeps the record writable and allows a later deletion retry', async () => {
  const persistence = new DataPersistence(), email = 'failed-delete@example.invalid'
  store.set(`user:${email}`, { token: 'keep' })
  delError = new Error('synthetic Redis failure')
  assert.equal(await persistence.deleteAccount(email), false)
  assert.equal(store.get(`user:${email}`).token, 'keep')
  delError = null
  assert.equal(await persistence.saveAccount(email, { expires: 123 }), true)
  assert.equal(await persistence.deleteAccount(email), true)
  assert.equal(store.has(`user:${email}`), false)
})

test('a Redis batch snapshot cannot overwrite an account deleted and recreated while it waited', async () => {
  const persistence = new DataPersistence()
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const original = FakeRedis.prototype.hset
  const a = 'batch-old@example.invalid', b = 'batch-blocked@example.invalid'
  store.set(`user:${a}`, { token: 'old' })
  FakeRedis.prototype.hset = async function (key, payload) {
    if (key === `user:${b}`) { entered(); await blocked }
    return original.call(this, key, payload)
  }
  try {
    const batch = persistence.saveAllAccounts([{ email: b, token: 'b' }, { email: a, token: 'old' }])
    await started
    assert.equal(await persistence.deleteAccount(a), true)
    assert.equal(await persistence.saveAccount(a, { token: 'new' }, { allowCreate: true }), true)
    release()
    await batch
    assert.equal(store.get(`user:${a}`).token, 'new')
  } finally { release(); FakeRedis.prototype.hset = original }
})
