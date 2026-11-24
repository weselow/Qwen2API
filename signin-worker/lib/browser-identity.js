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
 * itself, with the clean hints — and takes "Headless" out of its User-Agent.
 * That last part is easy to get wrong; each wrong way was measured against a
 * stand-in origin (tools/worker-identity-probe.js):
 *
 *   - the User-Agent string alone: the hints keep saying HeadlessChrome (the
 *     shell), or are not sent at all (the full Chromium, an override without
 *     metadata) — the page contradicts itself either way;
 *   - Playwright's `userAgent` option: it sends hints of its own making
 *     (platformVersion "10.0" where the browser says "19.0.0");
 *   - a CDP override whose session is detached: the browser reverts it.
 *
 * What works is to change the one word and to carry the browser's own hints,
 * read from the page before it goes anywhere, in a session kept for as long
 * as the context. With the window framed as a headed one, that matched a
 * headed launch of the same build on every field the probe reads — on Windows
 * and on Linux, in the worker's own image.
 */

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

// navigator.userAgentData exists in secure contexts only, and the page a
// fresh context opens is about:blank. This one is served by a route inside the
// browser, so nothing is requested from anywhere; .invalid is a TLD that can
// never resolve, for the day the route is not there.
const IDENTITY_URL = 'https://browser-identity.invalid/'
const IDENTITY_DOCUMENT = '<!doctype html><html><head></head><body></body></html>'

/**
 * Runs INSIDE the page: what the browser says about itself when nothing is
 * overridden — the fields of CDP's userAgentMetadata, and nothing else.
 */
async function readIdentityInPage() {
    const data = navigator.userAgentData
    const hints = data
        ? await data.getHighEntropyValues(['architecture', 'model', 'platformVersion', 'fullVersionList'])
        : {}
    return {
        userAgent: navigator.userAgent,
        brands: data ? data.brands : undefined,
        mobile: data ? data.mobile : undefined,
        platform: data ? data.platform : undefined,
        ...hints
    }
}

// An override built from half an identity would be worse than none: the
// measured cost of a User-Agent without its hints is a page that stands out.
const complete = identity => typeof identity?.userAgent === 'string' &&
    typeof identity.platform === 'string' && typeof identity.architecture === 'string' &&
    typeof identity.platformVersion === 'string' && typeof identity.model === 'string' &&
    typeof identity.mobile === 'boolean' &&
    Array.isArray(identity.brands) && identity.brands.length > 0 &&
    Array.isArray(identity.fullVersionList) && identity.fullVersionList.length > 0

async function readIdentity(context) {
    // A throwaway page. Routes belong to a page, and closing it drops the one
    // that serves the identity document: it must never answer for the real page.
    const scratch = await context.newPage()
    const serve = route => route.fulfill({ status: 200, contentType: 'text/html', body: IDENTITY_DOCUMENT })
    try {
        await scratch.route('**/*', serve)
        await scratch.goto(IDENTITY_URL, { waitUntil: 'domcontentloaded' })
        const identity = await scratch.evaluate(readIdentityInPage)
        if (!complete(identity)) throw new Error('The browser did not report its client hints.')
        return identity
    } finally {
        await scratch.close()
    }
}

// What the window of a headed browser adds around the viewport, per platform:
// the insets Playwright gives a headed persistent context. Without them a
// headless window is exactly as large as its viewport, which no window with a
// tab strip is.
const WINDOW_FRAME = { win32: [16, 134], linux: [8, 131], darwin: [2, 126] }

/**
 * Make a headless context on the full Chromium present as the same browser
 * with a window: "Chrome" where it says "HeadlessChrome", and nothing else.
 * Runs before the context's first navigation, so that the first request
 * already carries it.
 *
 * @param {object} context the persistent context, just launched
 * @param {{width: number, height: number}} viewport the context's viewport
 * @throws {Error} when the browser did not report its hints, or refused the override
 */
async function presentAsChrome(context, viewport) {
    const identity = await readIdentity(context)
    const [frameWidth, frameHeight] = WINDOW_FRAME[process.platform] || [24, 134]
    // One CDP session per page, kept for as long as the context lives.
    const sessions = []
    context.on('close', () => { for (const session of sessions) session.detach().catch(() => {}) })
    const present = async page => {
        const session = await context.newCDPSession(page)
        sessions.push(session)
        await session.send('Emulation.setUserAgentOverride', {
            userAgent: identity.userAgent.replace('HeadlessChrome', 'Chrome'),
            userAgentMetadata: {
                brands: identity.brands,
                fullVersionList: identity.fullVersionList,
                platform: identity.platform,
                platformVersion: identity.platformVersion,
                architecture: identity.architecture,
                model: identity.model,
                mobile: identity.mobile
            }
        })
        return session
    }
    const session = await present(context.pages()[0] || await context.newPage())
    // How large the window looks is worth nothing next to a launch that
    // works: if the browser will not resize it, the window stays its viewport's size.
    try {
        const { windowId } = await session.send('Browser.getWindowForTarget')
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { width: viewport.width + frameWidth, height: viewport.height + frameHeight }
        })
    } catch { /* as above */ }
    // Pages opened later get the same as soon as they exist. The worker only
    // ever drives the first one, so this is not waited for.
    context.on('page', page => { present(page).catch(() => {}) })
}

module.exports = { HEADLESS_MODES, IDENTITY_URL, parseHeadlessMode, presentAsChrome }
