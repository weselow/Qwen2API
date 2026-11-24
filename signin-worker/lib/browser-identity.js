'use strict'

/**
 * How a headless Chromium presents itself (Qwen2API-3ue.4).
 *
 * Both headless builds name the browser "HeadlessChrome" in the User-Agent
 * string. The headless shell — Playwright's default headless browser, and the
 * worker's until now — says so in its client hints too, and lacks what a
 * browser with a window has (window.chrome, the plugin list). Whether qwen.ai's
 * guard refuses a headless page is not known until the first live request
 * (docs/browser-egress-design.md, "HeadlessChrome"). If it does,
 * SIGNIN_HEADLESS_MODE=chrome is the switch to flip. It needs no other image:
 * `playwright install chromium` puts the full Chromium next to the shell.
 *
 * `chrome` launches that full Chromium — its headless mode is the browser
 * itself, with the clean hints — and takes "Headless" out of its User-Agent
 * through Playwright's `userAgent` option. That the override reaches every
 * frame is the whole point: Playwright sends it to each frame's session as the
 * frame starts, a captcha's iframe included. Each other way was measured
 * against a stand-in origin (tools/worker-identity-probe.js):
 *
 *   - a CDP override on the page alone: the page is clean, and a third-party
 *     iframe on it still calls itself HeadlessChrome to its own scripts and in
 *     the calls it makes — worse than useless, a page that disagrees with
 *     itself;
 *   - the User-Agent string alone, as an override without hints or as
 *     Chromium's --user-agent switch: the hints keep saying HeadlessChrome
 *     (the shell) or are not sent at all;
 *   - a CDP override whose session is detached: the browser reverts it.
 *
 * What the option costs is that the hints travel with metadata of Playwright's
 * own making — brands are still the browser's, but platformVersion is left
 * empty. On Linux the browser leaves it empty too, so there the mode matched a
 * headed launch of the same build on every field the probe reads, an iframe
 * from another site included. On Windows it differs in that one value ("10.0"
 * where the browser says "19.0.0"). Production is Linux.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HEADLESS_MODES = ['shell', 'chrome']

/**
 * SIGNIN_HEADLESS_MODE. Strict on purpose: this is a switch flipped during an
 * incident, and a typo that quietly meant the shell would keep sending live
 * requests from the very browser it was meant to replace.
 * @param {string} [raw]
 * @param {'shell'|'chrome'} [fallback='shell']
 * @returns {'shell'|'chrome'}
 * @throws {Error} on any other value
 */
function parseHeadlessMode(raw, fallback = 'shell') {
    if (raw === undefined || raw === null || raw === '') return fallback
    if (!HEADLESS_MODES.includes(raw)) {
        throw new Error(`SIGNIN_HEADLESS_MODE must be shell or chrome, not ${JSON.stringify(raw)}.`)
    }
    return raw
}

/**
 * Runs INSIDE the page. The User-Agent string is not behind a secure context,
 * so the page a fresh context opens will do.
 */
const readUserAgent = () => navigator.userAgent

// What the full Chromium calls itself, read once per process per launcher.
const stockUserAgents = new WeakMap()

async function readStockUserAgent(chromium, timeoutMs) {
    // A throwaway profile: the real one is touched by the one browser that uses it.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-worker-identity-'))
    let context
    try {
        context = await chromium.launchPersistentContext(dataDir, {
            headless: true, channel: 'chromium', chromiumSandbox: false, timeout: timeoutMs
        })
        const userAgent = await context.pages()[0].evaluate(readUserAgent)
        // (No word boundary inside "HeadlessChrome": both spellings are the browser's.)
        if (typeof userAgent !== 'string' || !/\b(?:Headless)?Chrome\/[\d.]+/.test(userAgent)) {
            throw new Error('The browser did not report its User-Agent.')
        }
        return userAgent
    } finally {
        if (context) await context.close().catch(() => {})
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
}

/**
 * The User-Agent the full Chromium gives when it is launched headless and left
 * alone. Nothing is requested anywhere to learn it: the browser opens, is
 * asked, and closes. Read once per process; a reading that failed is not kept.
 * @param {object} chromium Playwright's chromium object (a fake in tests)
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function stockUserAgentOf(chromium, timeoutMs) {
    let reading = stockUserAgents.get(chromium)
    if (!reading) {
        reading = readStockUserAgent(chromium, timeoutMs).catch(error => {
            stockUserAgents.delete(chromium)
            throw error
        })
        stockUserAgents.set(chromium, reading)
    }
    return reading
}

/** The User-Agent the full Chromium presents as in the chrome mode. */
const presentedUserAgent = stock => stock.replace('HeadlessChrome', 'Chrome')

// What the window of a headed browser adds around the viewport, per platform:
// the insets Playwright gives a headed persistent context. Without them a
// headless window is exactly as large as its viewport, which no window with a
// tab strip is.
const WINDOW_FRAME = { win32: [16, 134], linux: [8, 131], darwin: [2, 126] }

/**
 * Give the context's window the frame a headed one has. How large the window
 * looks is worth nothing next to a launch that works: a browser that will not
 * resize it keeps a window the size of its viewport, and the launch goes on.
 *
 * @param {object} context the persistent context, just launched
 * @param {{width: number, height: number}} viewport the context's viewport
 */
async function frameWindow(context, viewport) {
    try {
        const session = await context.newCDPSession(context.pages()[0] || await context.newPage())
        try {
            const { windowId } = await session.send('Browser.getWindowForTarget')
            const [frameWidth, frameHeight] = WINDOW_FRAME[process.platform] || [24, 134]
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: { width: viewport.width + frameWidth, height: viewport.height + frameHeight }
            })
        } finally {
            await session.detach().catch(() => {})
        }
    } catch { /* as above */ }
}

module.exports = { HEADLESS_MODES, parseHeadlessMode, stockUserAgentOf, presentedUserAgent, frameWindow }
