'use strict'

/**
 * What a page gives the worker's in-page call (signin-worker/lib/egress-fetch.js,
 * pageCall) for the worker's tests: a stand-in for the browser's
 * XMLHttpRequest over the fetch these tests have always scripted — a Response,
 * a ReadableStream fed by hand, an abort through init.signal. No Chromium
 * anywhere near CI: tools/worker-egress-local-smoke.js runs the same code on
 * a real one.
 *
 *   const sandbox = { ...pageGlobals(script, page), [binding]: call }
 *
 * `script` is read at call time, so a test can re-script it while a page lives:
 *
 *   fetch      (url, init) -> Promise<Response>   what "qwen.ai" answers; init carries the
 *                                                 request's method, headers, body and an AbortSignal
 *   hold       body => boolean                    an answer whose end never reaches the call — what
 *                                                 the page's request hooks do to one they take for a block
 *                                                 (xhr.release() tells the call of it after all, as when
 *                                                 the hooks let go)
 *   frontEnd   string                            the front end's version the page's scripts advertise;
 *                                                 '' for a page that shows none, 'elsewhere' for one
 *                                                 whose scripts show no version
 *   language   string                            the page's language (navigator.language)
 *   pageToken  string                            the session token the page keeps (localStorage.token)
 *   xhrs       XMLHttpRequest[]                  every request the page made, newest last
 *
 * Like the browser's, the stand-in tells the page's network about an answer
 * whatever it does with the call's own events: the `page` it was given hears
 * of it as Playwright's 'response' event.
 */

const CHAT = 'https://chat.qwen.ai'

/**
 * The globals pageCall needs beyond the ones every page has and the test
 * already provides (timers, btoa, the stream channel).
 * @param {{fetch?: Function, hold?: Function, frontEnd?: string, xhrs?: object[]}} script
 * @param {{emit?: Function}} [page] hears 'response' for every answer
 */
function pageGlobals(script, page = null) {
    return {
        XMLHttpRequest: xmlHttpRequest(script, page),
        TextEncoder,
        URL,
        location: { href: `${CHAT}/` },
        navigator: { get language() { return script.language || 'en-US' } },
        // What the page keeps in localStorage: its session's token, when it has one.
        localStorage: { getItem: name => (name === 'token' && script.pageToken) || null },
        document: pageDocument(script)
    }
}

/**
 * The front end's scripts, by the address they load from. Read off `script`
 * each time, for a page that is re-scripted while it lives.
 */
function pageDocument(script) {
    return {
        get scripts() {
            const version = script.frontEnd
            if (version === '') return []
            // 'elsewhere': scripts the version cannot be read off.
            if (version === 'elsewhere') return [{ src: `${CHAT}/static/js/app.9f31c2.js` }]
            return [{ src: `${CHAT}/scripts/qwen-chat-fe/${version || '0.3.50'}/js/index-stub.js` }]
        }
    }
}

/**
 * The stand-in. Every instance records what it was asked (`sent`): the
 * address, the method, the headers and the body.
 *
 * Two things are counted, because the real page's request hooks sit on them
 * and the worker's call must touch neither: a read of `readyState`
 * (`readyStateReads`), and an assignment to `onload`, `onloadend` or
 * `onreadystatechange` (`handlerProperties`).
 */
function xmlHttpRequest(script, page) {
    return class XMLHttpRequest {
        #state = 0
        #handlers = {}

        constructor() {
            this.status = 0
            this.responseURL = ''
            this.sent = null
            this.aborted = false
            this.listeners = new Map()
            this.text = ''
            ;(script.xhrs ||= []).push(this)
        }

        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set())
            this.listeners.get(type).add(listener)
        }

        removeEventListener(type, listener) {
            this.listeners.get(type)?.delete(listener)
        }

        dispatch(type) {
            for (const listener of this.listeners.get(type) || []) listener({ type })
        }

        open(method, url) {
            this.sent = { url, method, headers: {}, body: undefined }
            this.#state = 1
            this.dispatch('readystatechange')
        }

        setRequestHeader(name, value) {
            this.sent.headers[name.toLowerCase()] = value
        }

        get responseText() {
            // As the browser's does before the first of the body: nothing.
            return this.#state >= 3 ? this.text : ''
        }

        get readyState() {
            this.readyStateReads = (this.readyStateReads || 0) + 1
            return this.#state
        }

        set readyState(state) { this.#state = state }

        set onload(listener) { this.noteHandler('onload'); this.#handlers.onload = listener }
        get onload() { return this.#handlers.onload }
        set onloadend(listener) { this.noteHandler('onloadend'); this.#handlers.onloadend = listener }
        get onloadend() { return this.#handlers.onloadend }
        set onreadystatechange(listener) { this.noteHandler('onreadystatechange'); this.#handlers.onreadystatechange = listener }
        get onreadystatechange() { return this.#handlers.onreadystatechange }

        noteHandler(name) {
            (this.handlerProperties ||= []).push(name)
        }

        getAllResponseHeaders() {
            return (this.rawHeaders || []).map(([name, value]) => `${name}: ${value}`).join('\r\n')
        }

        send(body) {
            this.sent.body = body
            const controller = new AbortController()
            this.controller = controller
            const { url, method, headers } = this.sent
            // What fetch always got in these tests: the call's headers on the browser's credentials.
            this.init = { method, headers: { ...headers }, body, credentials: 'include', signal: controller.signal }
            Promise.resolve().then(() => script.fetch(url, this.init))
                .then(response => this.receive(response), () => this.fail())
        }

        abort() {
            if (this.aborted || this.#state === 4) return
            this.aborted = true
            this.#state = 4
            this.controller?.abort()
            this.dispatch('abort')
            this.dispatch('loadend')
        }

        /** qwen.ai's head: told to the call, and to the page's network. */
        receive(response) {
            this.status = response.status
            // A Response made by hand has no address of its own: it answered the one it was sent to.
            this.responseURL = response.url || this.sent.url
            this.rawHeaders = [...(response.headers instanceof Headers ? response.headers.entries() : Object.entries(response.headers || {}))]
                .map(([name, value]) => [name.toLowerCase(), value])
            this.#state = 2
            this.dispatch('readystatechange')
            // Taken before the body below is read, and answered to whoever asks
            // and however often: as Playwright's response.text() is.
            const copy = typeof response.clone === 'function' ? response.clone() : null
            let text = null
            page?.emit('response', {
                status: () => response.status,
                url: () => this.responseURL,
                headers: () => Object.fromEntries(this.rawHeaders),
                request: () => ({ method: () => this.sent.method, headers: () => ({ ...this.init.headers }) }),
                text: () => (text ||= copy ? copy.text().catch(() => '') : Promise.resolve(''))
            })
            if (!response.body) return this.finish()
            const reader = response.body.getReader()
            // As the browser decodes a body that arrives in pieces: a character cut in two waits.
            const decoder = new TextDecoder('utf-8')
            const pump = async () => {
                for (;;) {
                    const { done, value } = await reader.read()
                    if (this.aborted) return
                    if (done) {
                        this.text += decoder.decode()
                        return this.finish()
                    }
                    this.text += decoder.decode(value, { stream: true })
                    if (this.#state !== 3) {
                        this.#state = 3
                        this.dispatch('readystatechange')
                    }
                    this.dispatch('progress')
                }
            }
            pump().catch(() => { if (!this.aborted) this.fail() })
        }

        /**
         * The body is in. An answer the page's hooks take for a block is never
         * told to the call — until `release()`, as when they let go of it.
         */
        finish() {
            if (this.aborted) return
            if (script.hold && script.hold(this.text)) {
                this.held = true
                return
            }
            this.tellTheEnd()
        }

        /** The hooks let go of the answer they held: the call is told it now. */
        release() {
            if (!this.held || this.aborted) return
            this.held = false
            this.tellTheEnd()
        }

        tellTheEnd() {
            this.#state = 4
            this.dispatch('readystatechange')
            this.dispatch('progress')
            this.dispatch('load')
            this.dispatch('loadend')
        }

        /** The browser's own failure: a dead connection, a blocked request. */
        fail() {
            if (this.aborted) return
            this.#state = 4
            this.status = 0
            this.dispatch('error')
            this.dispatch('loadend')
        }
    }
}

module.exports = { pageGlobals, xmlHttpRequest, pageDocument }
