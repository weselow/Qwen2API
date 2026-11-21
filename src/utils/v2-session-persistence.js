const { CookieJar } = require('tough-cookie')
const store = require('./v2-session-store')
const DataPersistence = require('./data-persistence')
const signinWorker = require('./signin-worker-client')
const { logger } = require('./logger')
const { JwtDecode } = require('./tools')

/**
 * v2 browser-session persistence (Qwen2API-jik.4). The session store
 * (v2-session-store) is process memory; this module survives restarts:
 *
 *   restoreSessions()  startup: load persisted {token, expiresAt, jar} per
 *                      account back into the store, pruning dead records;
 *   publishSession()   token-manager's setSession + persist in one step;
 *   invalidateSession() 401/punish rejection: drop store + disk record and
 *                      trigger a silent renewal through the signin worker.
 *
 * Scope is browser mode only — lab sessions come from the .test stand's own
 * sign-in flow and stay ephemeral, and off mode has no sessions at all.
 * Storage lives in data-persistence (file 0600 / redis hash); the token is a
 * bearer credential, so every write path here treats it as secret (never
 * logged, never merged into data.json).
 */

const persistence = new DataPersistence()

// email -> in-flight renewal promise; parallel 401/punish hits on one account
// must not stampede the signin worker with N concurrent profile reloads.
const renewals = new Map()

function serializeSession(session) {
    return { token: session.token, expiresAt: session.expiresAt, jar: session.jar.toJSON() }
}

function deserializeJar(serialized) {
    try {
        const jar = CookieJar.fromJSON(
            typeof serialized === 'string' ? serialized : JSON.stringify(serialized)
        )
        return jar instanceof CookieJar ? jar : null
    } catch (error) {
        logger.warn(`v2 会话 jar 反序列化失败: ${error.message}`, 'V2SESSION')
        return null
    }
}

/**
 * Startup restore. Sessions whose token no longer decodes to a live expiry
 * are pruned from storage instead of restored — they could never match a
 * request anyway. A live session already in the store (this boot signed in
 * before the restore ran) always wins over the disk record.
 * @returns {Promise<number>} number of sessions restored into the store
 */
async function restoreSessions() {
    if (!store.browser) return 0
    const persisted = await persistence.loadV2Sessions()
    const now = Math.floor(Date.now() / 1000)
    let restored = 0
    let pruned = 0
    for (const [email, record] of Object.entries(persisted || {})) {
        const decoded = record && typeof record.token === 'string'
            ? JwtDecode(record.token)
            : null
        const jar = record ? deserializeJar(record.jar) : null
        if (!decoded || decoded.exp <= now || !jar) {
            // 死记录当场剔除：不剔除就会在存储里无限堆积
            await persistence.deleteV2Session(email)
            pruned++
            continue
        }
        if (store.sessions.has(email)) continue
        store.setSession(email, { token: record.token, expiresAt: decoded.exp, jar })
        restored++
    }
    if (restored || pruned) {
        logger.info(`v2 会话恢复完成: ${restored} 个有效, ${pruned} 个过期剔除`, 'V2SESSION', '🔁')
    }
    return restored
}

/**
 * Publish a freshly harvested session: memory store first (requests can use
 * it immediately), then persistence. Never throws — callers may fire and
 * forget; a persist failure costs a re-signin after the next restart, not
 * this request.
 * @returns {Promise<boolean>} whether the session reached storage
 */
async function publishSession(email, session) {
    if (!store.browser || !email || !session) return false
    store.setSession(email, session)
    const saved = await persistence.saveV2Session(email, serializeSession(session))
    if (!saved) {
        logger.warn(`v2 会话持久化失败 (${email})——重启后需重新登录`, 'V2SESSION')
    }
    return saved
}

/**
 * The upstream rejected the session: 401 (bearer/jar refused) or punish
 * (WAF challenge). Drop it from memory and storage, then trigger one silent
 * renewal via the signin worker so the NEXT request finds a live session.
 * No-op outside browser mode and when no session exists (nothing to void,
 * and a renewal storm on a worker-less deployment must not be possible).
 */
function invalidateSession(email, account, reason) {
    if (!store.browser || !email) return
    if (!store.sessions.has(email)) return
    store.deleteSession(email)
    const drop = persistence.deleteV2Session(email)
    logger.warn(`v2 会话失效 (${email}, 原因: ${reason})——触发 signin-worker 静默续期`, 'V2SESSION')
    scheduleRenewal(email, account, reason)
    return drop
}

async function renew(email, account, reason) {
    try {
        let harvested
        try {
            harvested = await signinWorker.renewSession(email, account)
        } catch (error) {
            // Мёртвый профиль — полный вход с паролем (та же семантика, что в
            // token-manager.refreshBrowserSession)
            if (!error.sessionLost) throw error
            harvested = await signinWorker.acquireSession(email, account?.password, account)
        }
        const decoded = JwtDecode(harvested.token)
        if (!decoded || decoded.exp <= Math.floor(Date.now() / 1000)) {
            throw new Error('renewed token has no live expiry')
        }
        // Пока шло продление, кто-то мог опубликовать более свежую сессию
        // (вход или авто-refresh) — существующую не вытесняем.
        if (store.sessions.has(email)) {
            logger.info(`v2 会话续期完成但已有更新会话 (${email})，丢弃续期结果`, 'V2SESSION')
            return
        }
        await publishSession(email, { token: harvested.token, expiresAt: decoded.exp, jar: harvested.jar })
        logger.success(`v2 会话已续期 (${email}, 触发原因: ${reason})`, 'V2SESSION')
    } catch (error) {
        logger.error(
            `v2 会话续期失败 (${email}, 触发原因: ${reason}): ${error.code || error.message}`,
            'V2SESSION'
        )
    }
}

function scheduleRenewal(email, account, reason) {
    if (renewals.has(email)) return
    const task = renew(email, account, reason).finally(() => renewals.delete(email))
    renewals.set(email, task)
}

module.exports = {
    restoreSessions,
    publishSession,
    invalidateSession,
    renewals,
    serializeSession,
    deserializeJar,
    // тот же инстанс DataPersistence, что используют publish/invalidate —
    // тестам нужно подменить пути на tmpdir
    persistence
}
