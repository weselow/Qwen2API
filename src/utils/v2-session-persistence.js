const { CookieJar } = require('tough-cookie')
const config = require('../config')
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
 *   invalidateSession() the upstream refused the session as unauthorized:
 *                      drop store + disk record and trigger a renewal through
 *                      the signin worker.
 *
 * Scope is browser mode only — lab sessions come from the .test stand's own
 * sign-in flow and stay ephemeral, and off mode has no sessions at all.
 * Storage lives in data-persistence (file 0600 / redis hash); the token is a
 * bearer credential, so every write path here treats it as secret (never
 * logged, never merged into data.json).
 *
 * Since Qwen2API-3ue.2 a refused session is recovered for real (epic
 * Qwen2API-3ue, docs/browser-egress-design.md):
 *
 *   recoverSession()   in-request: replace the refused (or missing) session by
 *                      a live one — the page is reloaded, a dead profile is
 *                      re-logged in — and hand it back so the caller can retry;
 *   syncCookies()      jar sync: the cookies the browser holds now, folded into
 *                      the stored session;
 *   readSetCookies()   the same for responses the app fetched itself.
 *
 * A renewal is live, never cached: the cached /renew is what made
 * "unauthorized → renewed" replay the refused jar for as long as its token had
 * TTL left (prod, 2026-11-23). Being live, it rotates the token — and the
 * account record follows it, or the next request would fail 409
 * v2_session_required until the periodic refresh. Every recovery is
 * single-flight per account and throttled, and so is every password sign-in
 * on top of that (with a doubling backoff), so a failing account cannot turn
 * its requests into a series of page reloads and logins.
 *
 * A WAF challenge is not a verdict on the session. It never drops one and
 * never earns a password login: the challenge is the IP's or the request's
 * doing, and a burst of logins is what gets an IP blocked (21.11).
 */

const persistence = new DataPersistence()

const WAF_CHALLENGE = 'upstream_waf_challenge'

// email -> in-flight renewal promise; parallel refusals on one account must
// not stampede the signin worker with N concurrent page reloads.
const renewals = new Map()
// email -> when its last recovery finished. One recovery per interval.
const recoveredAt = new Map()
// email -> when its last password sign-in was attempted.
const reloggedInAt = new Map()
// email -> sign-ins that did not lead to an accepted session. Each one doubles
// the wait before the next attempt, up to the periodic refresh's cadence: an
// account nothing helps must settle there, not keep logging in for as long as
// requests keep failing.
const reloginFailures = new Map()
const RELOGIN_BACKOFF_CEILING_MS = 15 * 60 * 1000
// Accounts whose session survived a page reload and was refused again. For
// those the next recovery is a sign-in — whenever one is allowed.
const reloginNeeded = new Set()

// Injectable, like parseClock in upload.js: tests advance the windows without sleeping.
let clock = () => Date.now()
const setRecoveryClockForTests = fn => { clock = typeof fn === 'function' ? fn : () => Date.now() }

const withinInterval = (since, email, minIntervalMs) => {
    const at = since.get(email)
    return at !== undefined && clock() - at < Math.max(0, minIntervalMs)
}
const recoveryThrottled = email => withinInterval(recoveredAt, email, config.sessionRecoveryMinIntervalMs)
const reloginIntervalMs = email => Math.min(
    config.sessionReloginMinIntervalMs * 2 ** (reloginFailures.get(email) || 0), RELOGIN_BACKOFF_CEILING_MS)
const reloginAllowed = email => !withinInterval(reloggedInAt, email, reloginIntervalMs(email))

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
 * The account record follows a session that rotated the token. Only a manager
 * that is already loaded can follow: this module must not be what pulls
 * account.js (and its timers) in.
 */
async function adoptToken(email, session) {
    const manager = require.cache[require.resolve('./account.js')]?.exports
    const saved = manager ? await manager.adoptSessionToken(email, session) : null
    if (saved === false) {
        logger.warn(`v2 会话 токен принят в памяти, но не сохранён (${email})——после рестарта нужен повторный вход`, 'V2SESSION')
    }
}

/**
 * One password sign-in — forced past the worker's live-session shortcut
 * (Qwen2API-43a) — at most one per interval per account. Resolves to the
 * harvested session, or to null when this account has to wait or has no
 * password. An attempt that fails counts like one whose session is refused
 * later: what the WAF counts is attempts.
 */
async function relogin(email, account) {
    if (!reloginAllowed(email)) {
        logger.warn(`v2 полный вход отложен (${email}): чаще одного раза в ${reloginIntervalMs(email)} мс входы не выполняются`, 'V2SESSION')
        return null
    }
    if (!account?.password) {
        logger.warn(`v2 полный вход невозможен (${email}): у аккаунта нет пароля`, 'V2SESSION')
        return null
    }
    reloggedInAt.set(email, clock())
    try {
        return await signinWorker.acquireSession(email, account.password, account, { force: true })
    } catch (error) {
        reloginFailures.set(email, (reloginFailures.get(email) || 0) + 1)
        throw error
    }
}

/**
 * One live session for an account whose session the upstream refused. The
 * page is reloaded live; a dead profile falls back to a password sign-in (the
 * semantics token-manager's refreshBrowserSession uses), and an account whose
 * session survived a reload goes straight to that sign-in — whenever one is
 * allowed, else back to the reload, which is what can still heal a refusal
 * that was merely transient. Never throws.
 *
 * @param {string} email
 * @param {Object} [account]
 * @param {*} reason - What the upstream said; a WAF challenge never earns a sign-in
 * @param {Object} [refused] - The session that was refused, if it is still in
 *   the store. A different one published meanwhile (a login, the periodic
 *   refresh) is newer and is not displaced.
 * @returns {Promise<Object|null>} the published session, or null
 */
async function renew(email, account, reason, refused) {
    try {
        let harvested
        let relogged = false
        if (reloginNeeded.has(email) && reloginAllowed(email)) {
            harvested = await relogin(email, account)
            relogged = Boolean(harvested)
        } else {
            try {
                harvested = await signinWorker.renewSession(email, account, { force: true })
            } catch (error) {
                // Мёртвый профиль — полный вход с паролем (та же семантика, что в
                // token-manager.refreshBrowserSession). Not after a WAF challenge:
                // a page that produced no token is then the challenge itself.
                if (!error.sessionLost || reason === WAF_CHALLENGE) throw error
                harvested = await relogin(email, account)
                relogged = Boolean(harvested)
            }
        }
        if (!harvested) return null
        const decoded = JwtDecode(harvested.token)
        if (!decoded || decoded.exp <= Math.floor(Date.now() / 1000)) {
            throw new Error('renewed token has no live expiry')
        }
        // Пока шло продление, кто-то мог опубликовать более свежую сессию
        // (вход или авто-refresh) — существующую не вытесняем.
        const current = store.sessions.get(email)
        if (current && current !== refused) {
            logger.info(`v2 会话续期完成但已有更新会话 (${email})，丢弃续期结果`, 'V2SESSION')
            return null
        }
        const session = { token: harvested.token, expiresAt: decoded.exp, jar: harvested.jar }
        if (relogged) session.reloggedIn = true
        await publishSession(email, session)
        await adoptToken(email, session)
        logger.success(`v2 会话已续期 (${email}, 触发原因: ${reason})`, 'V2SESSION')
        return session
    } catch (error) {
        logger.error(
            `v2 会话续期失败 (${email}, 触发原因: ${reason}): ${error.code || 'error'}${error.workerCode ? ` (${error.workerCode})` : ''}`,
            'V2SESSION'
        )
        return null
    }
}

/** Single-flight per account: every caller of one moment shares one renewal. */
function scheduleRenewal(email, account, reason, refused) {
    if (renewals.has(email)) return renewals.get(email)
    const task = renew(email, account, reason, refused).finally(() => {
        recoveredAt.set(email, clock())
        renewals.delete(email)
    })
    renewals.set(email, task)
    return task
}

/**
 * In-request recovery: the session the upstream just refused (or a missing
 * one) is replaced by a live one — now, so the caller can retry inside its
 * request. The refused session stays in place meanwhile: a failed recovery
 * leaves the account exactly as it was, not in a state nothing will renew.
 * Resolves to null at once inside the interval of the account's last recovery.
 * @returns {Promise<Object|null>} the live session, or null
 */
function recoverSession(email, account, reason) {
    if (!store.browser || !email) return Promise.resolve(null)
    if (renewals.has(email)) return renewals.get(email)
    if (recoveryThrottled(email)) return Promise.resolve(null)
    return scheduleRenewal(email, account, reason, store.sessions.get(email))
}

/**
 * The reloaded session was refused as unauthorized again: a page reload
 * cannot help this account, its next recovery is a sign-in. One starts now,
 * in the background (a reload instead while the sign-in has to wait). A
 * sign-in whose session was refused counts as a failed attempt — once per
 * sign-in: the requests that found its session refused share it.
 */
function escalateToRelogin(email, account, reason) {
    if (!store.browser || !email) return
    const refused = store.sessions.get(email)
    if (refused?.reloggedIn && !refused.reloginRefused) {
        refused.reloginRefused = true
        reloginFailures.set(email, (reloginFailures.get(email) || 0) + 1)
    }
    reloginNeeded.add(email)
    scheduleRenewal(email, account, reason, refused)
}

/** qwen.ai accepted the account's session: a later refusal starts over — a reload, and the base sign-in interval. */
const markSessionAccepted = email => {
    reloginNeeded.delete(email)
    reloginFailures.delete(email)
}

function dropSession(email, reason) {
    store.deleteSession(email)
    logger.warn(`v2 会话失效 (${email}, 原因: ${reason})——触发 signin-worker 续期`, 'V2SESSION')
    return persistence.deleteV2Session(email)
}

/**
 * The upstream refused the session as unauthorized (401). Drop it from
 * memory and storage, then trigger one live renewal via the signin worker so
 * the NEXT request finds a live session. An invalidation inside the interval
 * of the account's last recovery changes nothing: dropping the session there
 * would only leave 409 v2_session_required behind until a renewal is allowed
 * again. A WAF challenge changes nothing either — it is not about the session.
 * No-op outside browser mode and when no session exists (nothing to void,
 * and a renewal storm on a worker-less deployment must not be possible).
 */
function invalidateSession(email, account, reason) {
    if (!store.browser || !email) return
    if (!store.sessions.has(email)) return
    if (reason === WAF_CHALLENGE || recoveryThrottled(email)) return
    const drop = dropSession(email, reason)
    // A renewal already in flight publishes a session of its own.
    if (!renewals.has(email)) scheduleRenewal(email, account, reason)
    return drop
}

/**
 * Jar sync: a changed jar is written through, so storage stays at what the
 * browser holds. The write is not awaited — the next request reads memory.
 */
function persistJar(email, changed) {
    if (!changed || !store.browser) return false
    const session = store.sessions.get(email)
    if (session) persistence.saveV2Session(email, serializeSession(session))
    return true
}

const syncCookies = (email, cookies) => persistJar(email, store.mergeCookies(email, cookies))
const readSetCookies = (email, headers, url) => persistJar(email, store.ingestSetCookie(email, headers, url))

/**
 * The token the store holds for this account. A session recovered while a
 * chat was being created rotated it; the generation that follows must ride
 * the token prepareChat accepts, not the one the request started with.
 * @param {Object} [account]
 * @param {string} token - The token the request holds
 * @returns {string}
 */
function sessionToken(account, token) {
    const session = store.browser && account && store.sessions.get(account.email)
    return session ? session.token : token
}

function resetRecoveryForTests() {
    recoveredAt.clear()
    reloggedInAt.clear()
    reloginFailures.clear()
    reloginNeeded.clear()
}

module.exports = {
    restoreSessions,
    publishSession,
    invalidateSession,
    recoverSession,
    escalateToRelogin,
    markSessionAccepted,
    syncCookies,
    readSetCookies,
    sessionToken,
    renewals,
    serializeSession,
    deserializeJar,
    resetRecoveryForTests,
    setRecoveryClockForTests,
    // тот же инстанс DataPersistence, что используют publish/invalidate —
    // тестам нужно подменить пути на tmpdir
    persistence
}
