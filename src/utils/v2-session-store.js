const config = require('../config')
const { ChatCreationError } = require('./upstream-error')

/**
 * Per-account v2 session store (epic Qwen2API-jik), the generalization of the
 * lab cookie-jar proven on 2026-11-21:
 *   - lab mode: sessions acquired over HTTP against the .test stand
 *     (src/utils/v2-lab-sessions.js keeps that flow);
 *   - browser mode: sessions harvested by the signin-worker sidecar
 *     (src/utils/signin-worker-client.js) — token + cookies per account.
 *
 * prepareChat carries the session jar on the wire with the same domain/path
 * scoping semantics the lab validated (tough-cookie getCookiesSync per URL).
 */

const mode = config.v2SessionMode
const active = mode !== 'off'
const browser = mode === 'browser'

// The chat origin whose cookies the adapter carries. Lab validates it as an
// HTTPS .test origin inside v2-lab-sessions; browser uses the production base.
const chatOrigin = active ? new URL(config.qwenChatProxyUrl).origin : null

// email -> {token, expiresAt, jar}; same Map identity v2-lab-sessions re-exports.
const sessions = new Map()

function sessionFor(email, token) {
    const session = sessions.get(email)
    return session && session.token === token ? session : null
}

function setSession(email, session) {
    sessions.set(email, session)
}

function deleteSession(email) {
    sessions.delete(email)
}

function clearSessions() {
    sessions.clear()
}

// Rebuild a Set-Cookie string from a Playwright-shaped cookie; host-only
// cookies (no leading dot) keep their host-only scope in the jar.
function toSetCookieString(cookie) {
    const parts = [`${cookie.name}=${cookie.value}`]
    if (cookie.domain?.startsWith('.')) parts.push(`Domain=${cookie.domain}`)
    if (cookie.path) parts.push(`Path=${cookie.path}`)
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
        parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`)
    }
    if (cookie.secure) parts.push('Secure')
    if (cookie.httpOnly) parts.push('HttpOnly')
    if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
        parts.push(`SameSite=${cookie.sameSite}`)
    }
    return parts.join('; ')
}

function jarFromCookies(cookies) {
    const { CookieJar } = require('tough-cookie')
    const jar = new CookieJar()
    for (const cookie of [].concat(cookies || [])) {
        if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue
        const host = String(cookie.domain || new URL(config.qwenChatProxyUrl).hostname).replace(/^\./, '')
        const url = `https://${host}${cookie.path?.startsWith('/') ? cookie.path : '/'}`
        jar.setCookieSync(toSetCookieString(cookie), url, { ignoreError: true })
    }
    return jar
}

/**
 * Merge the account session jar into an outgoing request config, exactly as
 * the lab path does: server-set cookies for this URL win over same-named app
 * cookies; unrelated app cookies survive. Lab also pins proxy:false (local
 * stand); browser leaves routing to the caller's proxy config.
 */
function prepareChat(requestConfig, url, account, token) {
    if (!active) return
    if (new URL(url).origin !== chatOrigin) {
        throw new Error(mode === 'lab' ? 'Unexpected v2 lab chat origin' : 'Unexpected v2 chat origin')
    }
    if (mode === 'lab') Object.assign(requestConfig, { proxy: false, maxRedirects: 0 })
    const session = sessionFor(account?.email, token)
    if (!session) throw new ChatCreationError(browser ? 'v2_session_required' : 'lab_session_required', 409)
    const cookies = session.jar.getCookiesSync(url)
    if (!cookies.length) return
    // Preserve existing app cookies except where the server supplied the same name for this URL.
    const scopedNames = new Set(cookies.map(cookie => cookie.key))
    const legacy = (requestConfig.headers.cookie || '').split(/;\s*/).filter(pair =>
        pair && !scopedNames.has(pair.split('=', 1)[0]))
    requestConfig.headers.cookie = [...cookies.map(cookie => cookie.cookieString()), ...legacy].join('; ')
}

module.exports = {
    mode, active, browser, chatOrigin,
    sessions, sessionFor, setSession, deleteSession, clearSessions,
    jarFromCookies, toSetCookieString, prepareChat
}
