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

// A Playwright-shaped cookie as the jar stores it: host-only cookies (no
// leading dot) keep their host-only scope.
function setJarCookie(jar, cookie) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return
    const host = String(cookie.domain || new URL(config.qwenChatProxyUrl).hostname).replace(/^\./, '')
    const url = `https://${host}${cookie.path?.startsWith('/') ? cookie.path : '/'}`
    jar.setCookieSync(toSetCookieString(cookie), url, { ignoreError: true })
}

function jarFromCookies(cookies) {
    const { CookieJar } = require('tough-cookie')
    const jar = new CookieJar()
    for (const cookie of [].concat(cookies || [])) setJarCookie(jar, cookie)
    return jar
}

// What tells two jars apart for the store's purposes: which cookie is held,
// with which value and scope. The jar's own bookkeeping timestamps do not.
const jarFingerprint = jar => JSON.stringify(jar.toJSON().cookies
    .map(({ key, value, domain, path, hostOnly, secure, httpOnly, expires }) =>
        [key, value, domain, path, hostOnly, secure, httpOnly, expires])
    .sort())

/**
 * Jar sync (Qwen2API-3ue.2): fold the cookies the browser holds now into the
 * account session. Same semantics as prepareChat applies on the wire — a
 * server-set cookie wins over the stored one of the same name, domain and
 * path; every other stored cookie survives.
 * @param {string} email
 * @param {Object[]} cookies - Playwright-shaped, as the worker returns them
 * @returns {boolean} whether the stored jar changed
 */
function mergeCookies(email, cookies) {
    const session = browser ? sessions.get(email) : undefined
    if (!session || !Array.isArray(cookies)) return false
    const before = jarFingerprint(session.jar)
    for (const cookie of cookies) setJarCookie(session.jar, cookie)
    return jarFingerprint(session.jar) !== before
}

// RFC 6265 keeps commas out of a cookie value, but HTTP/1.1 lets a sender join
// several Set-Cookie headers with ", " (a proxy, `curl -i`, an HTTP/2 client).
// Split only before what is clearly the next cookie — a name and an "=" — so
// the comma of an Expires date ("Wed, 21 Oct 2015") stays where it belongs.
const NEXT_COOKIE = /,\s*(?=[^\s;(),]+\s*=)/g
const setCookieLines = (value) => [].concat(value || [])
    .flatMap(line => typeof line === 'string' ? line.split(NEXT_COOKIE) : [])
    .map(line => line.trim())
    .filter(Boolean)

/**
 * Absorb Set-Cookie from a response the app fetched itself (the direct calls
 * that remain in browser mode): the lab flow's readCookies, for the browser
 * jar. Server-set wins, as everywhere in the store.
 * @param {string} email
 * @param {Object} [headers] - Response headers (axios-shaped)
 * @param {string} url - The URL the response came from
 * @returns {boolean} whether the stored jar changed
 */
function ingestSetCookie(email, headers, url) {
    // Browser sessions only: a lab session's jar is fed by the lab's own flows.
    const session = browser ? sessions.get(email) : undefined
    const lines = session && typeof url === 'string' ? setCookieLines(headers?.['set-cookie']) : []
    if (!lines.length) return false
    const before = jarFingerprint(session.jar)
    for (const line of lines) session.jar.setCookieSync(line, url, { ignoreError: true })
    return jarFingerprint(session.jar) !== before
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
    jarFromCookies, toSetCookieString, prepareChat,
    mergeCookies, ingestSetCookie, setCookieLines
}
