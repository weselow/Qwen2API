const { CookieJar } = require('tough-cookie')
const { SigninError } = require('./signin-error')
const { detectWafChallenge } = require('./upstream-error')
const config = require('../config')
const store = require('./v2-session-store')

function labOrigin(value) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.test') ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('The v2 lab requires HTTPS .test origins')
    }
    return url.origin
}

// The lab HTTP flow only exists in lab mode; an explicit V2_SESSION_MODE wins
// over a stray QWEN_LAB_V2_AUTH_ORIGIN. Session state lives in the shared
// per-account store (same Map identity re-exported below for compatibility).
// No cookies are loaded from account storage or exposed on account records.
const authOrigin = config.v2SessionMode === 'lab' && process.env.QWEN_LAB_V2_AUTH_ORIGIN
    ? labOrigin(process.env.QWEN_LAB_V2_AUTH_ORIGIN)
    : null
const chatOrigin = authOrigin && labOrigin(config.qwenChatProxyUrl)

function readCookies(jar, response, url) {
    for (const line of [].concat(response.headers['set-cookie'] || [])) {
        jar.setCookieSync(line, url, { ignoreError: true })
    }
}

async function openAuthForm(httpClient) {
    const url = new URL('/auth', chatOrigin || 'https://chat.qwen.ai').href
    const response = await httpClient.get(url, {
        headers: { Accept: 'text/html' },
        proxy: false, maxRedirects: 0, timeout: 10000, maxContentLength: 2097152
    })
    if (response.status !== 200 || !/^text\/html\b/i.test(response.headers['content-type'] || '') ||
        typeof response.data !== 'string' || !response.data.trim() || detectWafChallenge(response.data)) {
        throw SigninError.fromResponse(response)
    }
    const jar = new CookieJar()
    readCookies(jar, response, url)
    return jar
}

function authenticatedJar(response, url, previous, validateToken) {
    const data = response.data
    if (response.status !== 200 || !/^application\/json\b/i.test(response.headers['content-type'] || '') ||
        data?.success === false || data?.error || detectWafChallenge(data) || typeof data?.token !== 'string' || !validateToken(data.token)) {
        throw SigninError.fromResponse(response)
    }
    const jar = previous ? previous.jar.cloneSync() : new CookieJar()
    readCookies(jar, response, url)
    return { token: data.token, jar }
}

module.exports = {
    authOrigin,
    // Shared per-account v2 session store (browser mode fills it via the
    // signin worker; lab via authenticatedJar above).
    sessions: store.sessions,
    sessionFor: store.sessionFor,
    prepareChat: store.prepareChat,
    openAuthForm,
    authenticatedJar
}
