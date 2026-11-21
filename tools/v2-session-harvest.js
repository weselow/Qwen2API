#!/usr/bin/env node
'use strict'

/**
 * v2 session harvest (jik.3): sign in to chat.qwen.ai in a real headless
 * Chromium, let the WAF captcha auto-pass, and persist the session to
 * .tmp/session-<email>.json (gitignored) for manual testing of jik.2 and the
 * lab probes. The profile under .tmp/ is reused across runs — a second run
 * with the same email does a silent renew, proving the persistent-context
 * renewal path.
 *
 * Prereqs: `bun install` (root) and `bunx playwright install chromium`.
 * Credentials arrive only via env: QWEN_TEST_EMAIL / QWEN_TEST_PASSWORD
 * (optional QWEN_SESSION_PROXY, HARVEST_HEADFUL=1 to watch the browser).
 *
 * stdout holds cookie NAMES and token expiry only — never values.
 */
process.env.ENABLE_FILE_LOG = 'false'
const fs = require('node:fs')
const path = require('node:path')
const { openContext, signin, renew, BrowserSigninError } = require('../signin-worker/lib/browser-signin')

const EMAIL = process.env.QWEN_TEST_EMAIL
const PASSWORD = process.env.QWEN_TEST_PASSWORD
const PROXY = process.env.QWEN_SESSION_PROXY || null
const HEADFUL = process.env.HARVEST_HEADFUL === '1'
const CHAT_ORIGIN = process.env.QWEN_CHAT_PROXY_URL || 'https://chat.qwen.ai'
const MODE = process.argv[2] === 'renew' ? 'renew' : 'signin'

const safeEmail = String(EMAIL || '').replace(/[^a-z0-9@._-]/gi, '_')

async function main() {
    if (!EMAIL || !PASSWORD) throw new Error('QWEN_TEST_EMAIL and QWEN_TEST_PASSWORD are required')
    const outDir = path.join(__dirname, '..', '.tmp')
    fs.mkdirSync(outDir, { recursive: true })
    const dataDir = path.join(outDir, `profile-${safeEmail}`)
    const context = await openContext({
        dataDir,
        proxy: PROXY,
        headless: !HEADFUL
    })
    try {
        const harvested = MODE === 'renew'
            ? await renew(context, { chatOrigin: CHAT_ORIGIN })
            : await signin(context, { email: EMAIL, password: PASSWORD, chatOrigin: CHAT_ORIGIN })
        const file = path.join(outDir, `session-${safeEmail}.json`)
        fs.writeFileSync(file, JSON.stringify({
            email: EMAIL,
            mode: MODE,
            harvestedAt: new Date().toISOString(),
            chatOrigin: CHAT_ORIGIN,
            token: harvested.token,
            exp: harvested.exp,
            expiresAt: new Date(harvested.exp * 1000).toISOString(),
            cookies: harvested.cookies
        }, null, 2))
        console.log(`outcome: ok (${MODE})`)
        console.log(`token expires: ${new Date(harvested.exp * 1000).toISOString()}`)
        console.log(`cookies: ${harvested.cookies.map(cookie => cookie.name).sort().join(', ')}`)
        console.log(`session file: ${file}`)
    } catch (error) {
        // Debug dump for live-Form tuning: URL, visible inputs and a screenshot
        // (no credentials ever reach it — only what the page itself shows).
        const page = context.pages()[0]
        if (page) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            try {
                await page.screenshot({ path: path.join(outDir, `harvest-failure-${stamp}.png`), fullPage: true })
                const inputs = await page.locator('input:visible').evaluateAll(nodes =>
                    nodes.map(node => ({ type: node.type, name: node.name, placeholder: node.placeholder || null })))
                console.error(`debug url: ${page.url()}`)
                console.error(`debug inputs: ${JSON.stringify(inputs)}`)
                console.error(`debug screenshot: ${path.join(outDir, `harvest-failure-${stamp}.png`)}`)
            } catch { /* page already gone */ }
        }
        throw error
    } finally {
        await context.close().catch(() => {})
    }
}

main().catch(error => {
    console.error(`outcome: failed (${error instanceof BrowserSigninError ? error.code : 'local_error'})`)
    console.error(String(error.message || error))
    process.exitCode = 1
})
