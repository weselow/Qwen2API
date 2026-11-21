const { CookieJar } = require('tough-cookie')
const { SigninError } = require('./signin-error')
const { detectWafChallenge } = require('./upstream-error')
const config = require('../config')

function labOrigin(value) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.test') ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('The v2 lab requires HTTPS .test origins')
    }
    return url.origin
}

// No cookies are loaded from account storage or exposed on account records.
const authOrigin = process.env.QWEN_LAB_V2_AUTH_ORIGIN && labOrigin(process.env.QWEN_LAB_V2_AUTH_ORIGIN)
const chatOrigin = authOrigin && labOrigin(config.qwenChatProxyUrl)
const sessions = new Map()

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

function sessionFor(email, token) {
    const session = sessions.get(email)
    return session && session.token === token ? session : null
}

function prepareChat(requestConfig, url, account, token) {
    if (!authOrigin) return
    if (new URL(url).origin !== chatOrigin) throw new Error('Unexpected v2 lab chat origin')
    Object.assign(requestConfig, { proxy: false, maxRedirects: 0 })
    const session = sessionFor(account?.email, token)
    if (!session) return
    const cookies = session.jar.getCookiesSync(url)
    if (!cookies.length) return
    // Preserve existing app cookies except where the server supplied the same name for this URL.
    const scopedNames = new Set(cookies.map(cookie => cookie.key))
    const legacy = (requestConfig.headers.cookie || '').split(/;\s*/).filter(pair =>
        pair && !scopedNames.has(pair.split('=', 1)[0]))
    requestConfig.headers.cookie = [...cookies.map(cookie => cookie.cookieString()), ...legacy].join('; ')
}

module.exports = { authOrigin, sessions, sessionFor, openAuthForm, authenticatedJar, prepareChat }
