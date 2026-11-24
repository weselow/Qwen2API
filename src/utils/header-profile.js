/**
 * Central browser header profile derived from per-account fingerprint.
 * Replaces 6+ duplicated hardcoded header blocks across the codebase.
 * Gated by config.antidetectTier1Enabled for instant rollback.
 */

const config = require('../config/index.js')
const { getTimezoneHeader } = require('./tools')

// chat.qwen.ai 前端版本（FE version）：请求头 Version 必须与线上前端一致，
// 否则 /api/v2/chat/completions 返回 Bad_Request（2026-11-21 实测线上为 0.3.49，
// 2026-11-24 线上为 0.3.50——页面自己请求里的 version，见 Qwen2API-3ue.5；
// 漂移检测：tools/et0-live-probe.js）。只用于直连路径：走 signin-worker 的
// 调用由页面自己给出它的版本（signin-worker/lib/egress-fetch.js）。
const QWEN_WEB_VERSION = '0.3.50'

// Refreshed against locally observed Chrome 157 (not a stable-release claim).
// Keep the existing four-major deterministic profile spread.
const CHROME_VERSIONS = ['157.0.0.0', '156.0.0.0', '155.0.0.0', '154.0.0.0']

/**
 * Derive a stable Chrome major version from fingerprint hash.
 * @param {Object} fingerprint
 * @returns {string}
 */
function pickChromeVersion(fingerprint) {
    if (!fingerprint || !fingerprint.hash) return CHROME_VERSIONS[0]
    const idx = parseInt(fingerprint.hash.slice(30, 32), 16) % CHROME_VERSIONS.length
    return CHROME_VERSIONS[idx]
}

/**
 * Map fingerprint platform to Sec-CH-UA-Platform value.
 * @param {string} platform - e.g. 'MacIntel', 'Win32', 'Linux x86_64'
 * @returns {string}
 */
function platformToSecChUa(platform) {
    if (platform === 'MacIntel') return '"macOS"'
    if (platform === 'Win32') return '"Windows"'
    if (platform && platform.startsWith('Linux')) return '"Linux"'
    return '"Windows"'
}

/**
 * Build User-Agent string consistent with fingerprint platform.
 * @param {Object} fingerprint
 * @returns {string}
 */
function buildUserAgent(fingerprint) {
    const ver = pickChromeVersion(fingerprint)
    const platform = fingerprint && fingerprint.platform
    if (platform === 'MacIntel') {
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
    }
    if (platform && platform.startsWith('Linux')) {
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
    }
    // Default Windows
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
}

/**
 * Build Sec-CH-UA header value.
 * @param {Object} fingerprint
 * @returns {string}
 */
function buildSecChUa(fingerprint) {
    const ver = pickChromeVersion(fingerprint)
    const major = ver.split('.')[0]
    return `"Not-A.Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`
}

/**
 * Legacy static headers used when ANTIDETECT_TIER1_ENABLED=false.
 * Uses the refreshed default browser identity without per-account variation.
 */
const LEGACY_HEADERS = {
    'sec-ch-ua-platform': '"Windows"',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': buildSecChUa(),
    'sec-ch-ua-mobile': '?0',
    'user-agent': buildUserAgent()
}

const LEGACY_UA = LEGACY_HEADERS['user-agent']

/**
 * Signin-specific browser context. Never assemble chat authentication cookies,
 * Authorization, frontend Version, timezone or source headers here.
 * These headers improve consistency; they are not a demonstrated WAF remedy.
 * Let axios negotiate supported encodings and connection framing.
 */
function buildSigninHeaders(account, options = {}) {
    const fp = config.antidetectTier1Enabled && account && account.fingerprint
    const language = fp && fp.language || 'zh-CN'
    const headers = {
        'user-agent': buildUserAgent(fp),
        'sec-ch-ua': buildSecChUa(fp),
        'sec-ch-ua-platform': platformToSecChUa(fp && fp.platform),
        'sec-ch-ua-mobile': '?0',
        'accept': 'application/json',
        'content-type': 'application/json',
        'accept-language': language.includes('-') ? `${language},${language.split('-')[0]};q=0.9` : language,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'priority': 'u=1, i'
    }
    if (options.chatBaseUrl) {
        const origin = new URL(options.chatBaseUrl).origin
        headers.origin = origin
        headers.referer = `${origin}/auth`
    }
    return headers
}


/**
 * Build the timezone header in the live FE's format ('Sat Nov 21 2026 19:55:52 GMT+0400')
 * from a fingerprint timezoneOffset (minutes behind UTC, as Date#getTimezoneOffset).
 * 2026-11-21 live capture sends this exact shape; the old 'UTC+04' form is not FE-shaped.
 * @param {number} tzOffset - getTimezoneOffset-style minutes (UTC+4 => -240)
 * @returns {string}
 */
function fingerprintTimezoneHeader(tzOffset) {
    const shifted = new Date(Date.now() - tzOffset * 60000)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const pad = n => String(n).padStart(2, '0')
    const sign = tzOffset <= 0 ? '+' : '-'
    const hours = Math.abs(tzOffset) / 60
    const hhmm = `${pad(Math.floor(hours))}${pad(Math.round((hours % 1) * 60))}`
    return `${days[shifted.getUTCDay()]} ${months[shifted.getUTCMonth()]} ${pad(shifted.getUTCDate())} ` +
        `${shifted.getUTCFullYear()} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
        `${pad(shifted.getUTCSeconds())} GMT${sign}${hhmm}`
}

/**
 * Build full request headers for an upstream Qwen API call.
 * @param {Object} account - Account object (must have .fingerprint after ensureAccountFingerprint)
 * @param {Object} options - Additional header overrides or context
 * @param {string} [options.chatBaseUrl] - Base URL for referer/host/origin
 * @param {string} [options.token] - JWT token for cookie assembly
 * @param {string} [options.ssxmodItna] - Per-account ssxmod_itna value
 * @param {string} [options.ssxmodItna2] - Per-account ssxmod_itna2 value
 * @param {string} [options.accept] - Accept header value
 * @param {string} [options.refererPath] - Referer path suffix (default '/')
 * @param {boolean} [options.stream] - Whether this is a streaming request
 * @param {Object} [options.extra] - Additional headers to merge
 * @returns {Object} Complete headers object
 */
function buildRequestHeaders(account, options = {}) {
    // Feature flag gate: revert to legacy static headers
    if (!config.antidetectTier1Enabled) {
        const headers = {
            ...LEGACY_HEADERS,
            'content-type': 'application/json',
            'accept': options.accept || 'application/json',
            'accept-encoding': 'gzip, deflate, br, zstd',
            'source': 'web',
            'Version': QWEN_WEB_VERSION,
            'timezone': getTimezoneHeader(),
            'connection': 'keep-alive',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
        }
        if (options.chatBaseUrl) {
            headers['referer'] = `${options.chatBaseUrl}${options.refererPath || '/'}`
            headers['host'] = options.chatBaseUrl.replace(/^https?:\/\//, '')
            headers['origin'] = options.chatBaseUrl
        }
        if (options.token) {
            const cookieParts = [`token=${options.token}`]
            if (options.ssxmodItna) cookieParts.push(`ssxmod_itna=${options.ssxmodItna}`)
            if (options.ssxmodItna2) cookieParts.push(`ssxmod_itna2=${options.ssxmodItna2}`)
            headers['cookie'] = cookieParts.join(';')
            // FE 0.3.x 起 completions 硬校验 Bearer 鉴权（缺失则 Unauthorized），与前端 eX 拦截器一致
            headers['Authorization'] = `Bearer ${options.token}`
        }
        if (options.extra) Object.assign(headers, options.extra)
        return headers
    }

    const fp = account && account.fingerprint
    const ua = fp ? buildUserAgent(fp) : LEGACY_UA
    const secChUa = fp ? buildSecChUa(fp) : LEGACY_HEADERS['sec-ch-ua']
    const secChPlatform = fp ? platformToSecChUa(fp.platform) : LEGACY_HEADERS['sec-ch-ua-platform']
    const language = fp ? fp.language || 'zh-CN' : 'zh-CN'

    // Derive timezone from fingerprint offset; fall back to server TZ only when missing or invalid
    const rawTz = fp && fp.timezoneOffset != null ? Number(fp.timezoneOffset) : NaN
    const tzOffset = Number.isFinite(rawTz) ? Math.trunc(rawTz) : null
    const timezone = tzOffset !== null ? fingerprintTimezoneHeader(tzOffset) : getTimezoneHeader()

    const headers = {
        'sec-ch-ua-platform': secChPlatform,
        'accept-language': language.includes('-') ? `${language},${language.split('-')[0]};q=0.9` : language,
        'sec-ch-ua': secChUa,
        'sec-ch-ua-mobile': '?0',
        'user-agent': ua,
        'content-type': 'application/json',
        'accept': options.accept || 'application/json',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'source': 'web',
        'Version': QWEN_WEB_VERSION,
        'timezone': timezone,
        'connection': 'keep-alive',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
    }

    if (options.chatBaseUrl) {
        headers['referer'] = `${options.chatBaseUrl}${options.refererPath || '/'}`
        headers['host'] = options.chatBaseUrl.replace(/^https?:\/\//, '')
        headers['origin'] = options.chatBaseUrl
    }

    if (options.token) {
        const cookieParts = [`token=${options.token}`]
        if (options.ssxmodItna) cookieParts.push(`ssxmod_itna=${options.ssxmodItna}`)
        if (options.ssxmodItna2) cookieParts.push(`ssxmod_itna2=${options.ssxmodItna2}`)
        headers['cookie'] = cookieParts.join(';')
        // FE 0.3.x 起 completions 硬校验 Bearer 鉴权（缺失则 Unauthorized），与前端 eX 拦截器一致
        headers['Authorization'] = `Bearer ${options.token}`
    }

    if (options.extra) Object.assign(headers, options.extra)

    return headers
}

module.exports = {
    buildSigninHeaders,
    buildRequestHeaders,
    buildUserAgent,
    buildSecChUa,
    platformToSecChUa,
    pickChromeVersion,
    fingerprintTimezoneHeader,
    LEGACY_HEADERS,
    LEGACY_UA
}
