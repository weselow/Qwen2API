'use strict'

/**
 * Browser sign-in flow for chat.qwen.ai (FE 0.3.49).
 *
 * Proven live 2026-11-21 (docs/et0-live-integration-2026-11-21.md): the Aliyun
 * slider captcha auto-passes inside a real Chromium context, while pure-Node
 * signin is WAF-blocked. Everything here runs inside a persistent context
 * (userDataDir) so auth.qwen.ai session cookies survive restarts and renewal
 * is a silent reload.
 *
 * Credentials never reach logs, screenshots or error messages.
 */

const jwtExp = token => {
    const part = String(token).split('.')[1]
    if (!part) return null
    try {
        const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
        return Number.isFinite(payload?.exp) ? payload.exp : null
    } catch {
        return null
    }
}

const parseProxy = proxy => {
    if (!proxy) return undefined
    let url
    try {
        url = new URL(proxy)
    } catch {
        throw new Error(`Unsupported proxy URL for the browser context`)
    }
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) {
        throw new Error(`Proxy protocol ${url.protocol} is not supported by the browser context`)
    }
    const server = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`
    return url.username || url.password
        ? { server, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
        : { server }
}

class BrowserSigninError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Launch a persistent Chromium context. One userDataDir per account; Chromium
 * locks the profile, so callers must serialize access per directory.
 */
async function openContext({ dataDir, proxy, headless = true, timeoutMs = 30000 }) {
    const { chromium } = require('playwright')
    return chromium.launchPersistentContext(dataDir, {
        headless,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        // Container runs without CAP_SYS_ADMIN; a real display keeps the sandbox off anyway.
        chromiumSandbox: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
        proxy: parseProxy(proxy),
        timeout: timeoutMs
    })
}

/** Wait until the FE settles on a stable token (it may rotate it shortly after load). */
async function readStableToken(page) {
    let previous = null
    for (let attempt = 0; attempt < 8; attempt++) {
        const token = await page.evaluate(() => localStorage.getItem('token'))
        if (token && token === previous) return token
        previous = token || null
        await sleep(500)
    }
    return previous
}

const EMAIL_INPUT = 'input[type="email"], input[name="email"], input[placeholder*="mail" i]'
const PASSWORD_INPUT = 'input[type="password"]'

async function firstVisible(page, selector, timeoutMs) {
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return locator
}

async function typeHuman(locator, text) {
    await locator.click()
    await locator.fill('')
    for (const char of text) {
        await locator.press(char, { delay: 40 + Math.floor(Math.random() * 60) })
    }
}

/**
 * Full interactive sign-in: open /auth, switch to password login, submit
 * credentials, let the WAF captcha auto-pass, land on chat.qwen.ai/.
 */
async function signin(context, { email, password, chatOrigin = 'https://chat.qwen.ai', timeoutMs = 120000 }) {
    const page = context.pages()[0] || await context.newPage()
    const failure = await page.goto(`${chatOrigin}/auth`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (!failure?.ok()) throw new BrowserSigninError('browser_error', `Auth form load returned HTTP ${failure?.status()}`)

    // Already signed in (persisted profile): the FE redirects away from /auth.
    if (!page.url().includes('/auth')) return finish(page, context, chatOrigin)

    // Some FE builds open on a verification-code form; flip to password login when a switch exists.
    for (const toggle of [page.getByText('password', { exact: false }).first()]) {
        try {
            await toggle.click({ timeout: 3000 })
            break
        } catch { /* form is already password-mode */ }
    }

    try {
        await typeHuman(await firstVisible(page, EMAIL_INPUT, 20000), email)
    } catch {
        throw new BrowserSigninError('form_not_found', 'Email input not found on the auth form.')
    }
    // Most builds reveal the password field only after the email is confirmed.
    let passwordField = null
    try {
        passwordField = await firstVisible(page, PASSWORD_INPUT, 2000)
    } catch { /* not a single-step form */ }
    if (!passwordField) {
        await page.keyboard.press('Enter')
        try {
            passwordField = await firstVisible(page, PASSWORD_INPUT, 15000)
        } catch {
            throw new BrowserSigninError('form_not_found', 'Password input not found on the auth form.')
        }
    }
    await typeHuman(passwordField, password)
    await passwordField.press('Enter')

    // Captcha auto-passes in a real context; just wait out the navigation.
    try {
        await page.waitForURL(url => !url.pathname.startsWith('/auth'), { timeout: timeoutMs })
    } catch {
        const body = (await page.content()).toLowerCase()
        if (/password is incorrect|wrong password|invalid (email|password)|too many attempts/.test(body)) {
            throw new BrowserSigninError('invalid_credentials', 'Qwen rejected the credentials.')
        }
        throw new BrowserSigninError('captcha_stuck', 'Sign-in did not leave the auth page (captcha or form error).')
    }
    return finish(page, context, chatOrigin)
}

async function finish(page, context, chatOrigin) {
    const token = await readStableToken(page)
    if (!token) throw new BrowserSigninError('signin_timeout', 'No token in localStorage after sign-in.')
    const exp = jwtExp(token)
    if (!exp) throw new BrowserSigninError('browser_error', 'The harvested token is not a JWT.')
    const origin = new URL(chatOrigin).origin
    const cookies = await context.cookies([origin, 'https://auth.qwen.ai'])
    return { token, exp, cookies }
}

/**
 * Silent renewal: reload the chat root inside the persisted profile. The FE
 * rotates localStorage.token via its auth.qwen.ai session cookies — no
 * credentials involved. Fails with session_expired when the profile is dead.
 */
async function renew(context, { chatOrigin = 'https://chat.qwen.ai', timeoutMs = 60000 }) {
    const page = context.pages()[0] || await context.newPage()
    await page.goto(`${chatOrigin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (page.url().includes('/auth')) {
        throw new BrowserSigninError('session_expired', 'The persisted profile no longer authenticates.')
    }
    try {
        await page.waitForFunction(() => Boolean(localStorage.getItem('token')), null, { timeout: timeoutMs })
    } catch {
        throw new BrowserSigninError('session_expired', 'The reloaded page produced no token.')
    }
    return finish(page, context, chatOrigin)
}

module.exports = { openContext, signin, renew, BrowserSigninError, jwtExp, parseProxy }
