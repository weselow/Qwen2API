'use strict'

/*
 * A loopback-only network guard for the processes of the smoke test
 * (tools/bun-smoke.js loads it before anything else). The stand-ins the smoke
 * runs listen on 127.0.0.1, and nothing else may be reached: a request to
 * anywhere beyond the loopback interface is refused before a name is resolved
 * or a socket opens, with an error whose code is ENETGUARD.
 *
 * Every way out is wrapped where it starts — fetch, WebSocket, the HTTP, HTTPS
 * and HTTP/2 clients, net and tls connects, the resolvers, UDP — because the
 * runtime at hand decides which of them the others run through (in Node they
 * all end in net.Socket.prototype.connect; in Bun the clients are native and
 * that one is not on their way). selfTest() proves the wraps hold in the
 * runtime at hand before the smoke starts anything; `blocked` is the record
 * of what was refused.
 *
 * The application under test is not covered and cannot be: it runs as a
 * compiled Bun binary, which loads no preload at all (NODE_OPTIONS=--require,
 * --require and --preload are ignored by a compiled executable on Bun 1.3.14).
 * It is kept to the loopback by its configuration instead — the upstream
 * addresses it reads from the environment all go to a stand-in on 127.0.0.1,
 * and the stand-in writes down every call it gets, the direct ones included
 * (tools/bun-smoke-browser.js).
 */

const LOOPBACK_NAMES = new Set(['', 'localhost', '0.0.0.0', '::', '::1'])
const isLoopback = host => {
    const value = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    return LOOPBACK_NAMES.has(value) ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ||
        /^::ffff:127\.\d{1,3}\.\d{1,3}$/.test(value)
}

// What was refused, in order: { api, host, port }.
const blocked = []

function refuse(api, host, port) {
    blocked.push({ api, host: String(host ?? ''), port })
    const error = new Error(
        `net-guard: refused ${api} to ${host || 'the default host'}${port ? `:${port}` : ''}; ` +
        'the smoke test may reach the loopback interface only')
    error.code = 'ENETGUARD'
    return error
}

// What connect was asked for: connect(options[, cb]), connect(path[, cb]) or
// connect(port[, host][, cb]).
const targetOf = args => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (first && typeof first === 'object') return { host: first.host ?? first.hostname, port: first.port, path: first.socketPath ?? first.path }
    return { host: typeof args[1] === 'string' ? args[1] : undefined, port: args[0], path: undefined }
}

// What http.request was asked for: (url[, options][, cb]) or (options[, cb]).
const targetOfRequest = args => {
    const first = args[0]
    if (typeof first === 'string' || first instanceof URL) {
        const url = new URL(String(first))
        const options = args[1] && typeof args[1] === 'object' ? args[1] : {}
        return { host: options.host ?? options.hostname ?? url.hostname, port: options.port ?? url.port, path: options.socketPath }
    }
    return { host: first?.host ?? first?.hostname, port: first?.port, path: first?.socketPath }
}

// A function that lets the loopback through and refuses the rest before it starts.
const guarded = (api, real, target) => function guard(...args) {
    const { host, port, path } = target(args)
    // A unix socket is a file on this machine, not the network.
    if (!path && !isLoopback(host)) throw refuse(api, host, port)
    return real.apply(this, args)
}

// Names beyond the loopback ones cannot be resolved either: a library that
// resolves first and connects after must not get as far as the socket. The
// resolvers live in three places: on `dns` (callbacks), on `dns.promises`, and
// on the Resolver classes' prototypes.
const guardResolver = (owner, name) => {
    const real = owner && owner[name]
    if (typeof real !== 'function') return
    owner[name] = function guardedResolver(...args) {
        const host = args[0]
        if (isLoopback(host)) return real.apply(this, args)
        const error = refuse(`dns.${name}`, host)
        const callback = args.find(candidate => typeof candidate === 'function')
        if (callback) { process.nextTick(callback, error); return }
        return Promise.reject(error)
    }
}

const RESOLVER_METHODS = [
    'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
    'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa',
    'resolveTxt', 'reverse'
]

// Where a method is defined: the prototype itself or one further up the chain
// (Bun's callback Resolver inherits its methods from above its own prototype).
const ownerOf = (prototype, name) => {
    for (let owner = prototype; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.prototype.hasOwnProperty.call(owner, name)) return owner
    }
    return null
}

let installed = null

function install() {
    if (installed) return installed
    const net = require('node:net')
    const tls = require('node:tls')
    const http = require('node:http')
    const https = require('node:https')
    const dns = require('node:dns')
    const dgram = require('node:dgram')

    net.Socket.prototype.connect = guarded('net.Socket#connect', net.Socket.prototype.connect, targetOf)
    for (const name of ['connect', 'createConnection']) {
        if (typeof net[name] === 'function') net[name] = guarded(`net.${name}`, net[name], targetOf)
    }
    tls.connect = guarded('tls.connect', tls.connect, targetOf)
    for (const [label, module] of [['http', http], ['https', https]]) {
        for (const name of ['request', 'get']) {
            if (typeof module[name] === 'function') module[name] = guarded(`${label}.${name}`, module[name], targetOfRequest)
        }
    }
    for (const name of RESOLVER_METHODS) {
        guardResolver(dns, name)
        guardResolver(dns.promises, name)
    }
    for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
        if (typeof Resolver !== 'function') continue
        for (const name of RESOLVER_METHODS) guardResolver(ownerOf(Resolver.prototype, name), name)
    }
    // UDP has no place in the smoke at all.
    for (const [owner, name] of [[dgram, 'createSocket'], [globalThis.Bun, 'udpSocket']]) {
        const real = owner && owner[name]
        if (typeof real !== 'function') continue
        owner[name] = function noUdp() { throw refuse(`${name}`, '(any)') }
    }
    // Bun's own clients: a TCP connect, and its fetch and WebSocket are the globals.
    if (typeof globalThis.Bun?.connect === 'function') {
        // Bun.connect({ hostname, port }) or Bun.connect(hostname, port).
        globalThis.Bun.connect = guarded('Bun.connect', globalThis.Bun.connect, args =>
            (args[0] && typeof args[0] === 'object' ? { host: args[0].hostname ?? args[0].host, port: args[0].port } : { host: args[0], port: args[1] }))
    }
    const guardedAsync = (api, real, target) => function guard(...args) {
        let where
        try {
            where = target(args)
        } catch (error) { return Promise.reject(error) }
        const { host, port, path } = where
        if (!path && !isLoopback(host)) return Promise.reject(refuse(api, host, port))
        return real.apply(this, args)
    }
    const urlTarget = args => {
        const first = args[0]
        const url = first instanceof Request ? new URL(first.url) : new URL(String(first))
        return { host: url.hostname, port: url.port, path: url.protocol === 'file:' ? first : undefined }
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = guardedAsync('fetch', realFetch, urlTarget)
    // A proxy in the environment would carry even a loopback request off this
    // machine, past every wrap: Bun's fetch takes the proxy variables when it
    // starts (deleting them later changes nothing) and reads no_proxy as it
    // goes (1.3.14). So the loopback is exempted from any proxy, in both spellings.
    for (const name of ['no_proxy', 'NO_PROXY']) {
        const entries = String(process.env[name] || '').split(',').map(entry => entry.trim()).filter(Boolean)
        for (const host of ['127.0.0.1', 'localhost', '::1']) {
            if (!entries.includes(host)) entries.push(host)
        }
        process.env[name] = entries.join(',')
    }
    const RealWebSocket = globalThis.WebSocket
    if (typeof RealWebSocket === 'function') {
        globalThis.WebSocket = class GuardedWebSocket extends RealWebSocket {
            constructor(...args) {
                const { host, port } = urlTarget(args)
                if (!isLoopback(host)) throw refuse('WebSocket', host, port)
                super(...args)
            }
        }
    }
    try {
        const http2 = require('node:http2')
        if (typeof http2.connect === 'function') {
            http2.connect = guarded('http2.connect', http2.connect, args => {
                const first = args[0]
                if (typeof first === 'string' || first instanceof URL) return urlTarget(args)
                return { host: first?.host ?? first?.hostname, port: first?.port, path: first?.socketPath }
            })
        }
    } catch { /* no http2 in this runtime: nothing to wrap */ }

    installed = { blocked, isLoopback, selfTest }
    return installed
}

// One attempt at a connection: what became of it, as a line of codes along the
// error's causes (fetch and the streams wrap the guard's error in their own).
const PROBES_TIMEOUT_MS = 5000
const codeOf = error => {
    if (error === undefined) return 'NO-ERROR'
    if (typeof error === 'string') return `OK:${error}`
    const codes = []
    for (let cause = error; cause && codes.length < 5; cause = cause.cause) {
        codes.push(cause.code || String(cause.message).slice(0, 60))
    }
    return codes.join('<-')
}
const attempt = run => new Promise(resolve => {
    const timer = setTimeout(() => resolve('TIMEOUT'), PROBES_TIMEOUT_MS)
    const done = error => { clearTimeout(timer); resolve(codeOf(error)) }
    try {
        const result = run(done)
        if (result && typeof result.then === 'function') result.then(value => done(value), done)
    } catch (error) { done(error) }
})
// A runtime without the guard would answer none of these; they say so in place of a hang.
const unguarded = () => Object.assign(new Error('not refused, and no answer'), { code: 'ETIMEDOUT' })

/*
 * Proves the wraps hold where this process runs: every client must still reach
 * the loopback, and must refuse the outside world with the guard's own error,
 * before anything is sent. The targets are reserved for documentation
 * (RFC 5737, RFC 6761): should a wrap not hold, the attempt that slips out
 * names no real host. Throws when anything is not as it must be.
 */
async function selfTest() {
    const net = require('node:net')
    const tls = require('node:tls')
    const http = require('node:http')
    const https = require('node:https')
    const dns = require('node:dns')
    const http2 = require('node:http2')
    const OUTSIDE = '192.0.2.1'
    const results = []
    const probe = async (label, run) => { results.push({ label, code: await attempt(run) }) }
    const refused = error => error.split('<-').includes('ENETGUARD')
    const ok = code => code.startsWith('OK:')

    const server = http.createServer((request, response) => { response.end('loopback') })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const local = `http://127.0.0.1:${port}`
    const getBody = (done, options) => http.get(options, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => done(`status ${response.statusCode} ${body}`))
    }).on('error', done)
    const connects = (done, make) => {
        let socket
        try { socket = make() } catch (error) { return done(error) }
        socket.once('connect', () => { socket.destroy(); done(`OK:connected ${socket.remoteAddress}`) })
        socket.once('secureConnect', () => { socket.destroy(); done(`OK:connected ${socket.remoteAddress}`) })
        socket.once('error', done)
    }
    const outsideSocket = (done, make) => {
        const timer = setTimeout(() => { done(unguarded()); try { socket?.destroy() } catch { /* gone already */ } }, 3000)
        let socket
        try { socket = make() } catch (error) { clearTimeout(timer); return done(error) }
        for (const event of ['connect', 'secureConnect']) {
            socket.once(event, () => { clearTimeout(timer); socket.destroy(); done('OK:connected') })
        }
        socket.once('error', error => { clearTimeout(timer); done(error) })
    }

    // --- the loopback must work
    await probe('L http.get to 127.0.0.1', done => getBody(done, { host: '127.0.0.1', port }))
    await probe('L http.get to localhost', done => getBody(done, { host: 'localhost', port }))
    await probe('L http.get by url', done => http.get(`${local}/x`, response => {
        response.resume()
        response.on('end', () => done(`status ${response.statusCode}`))
    }).on('error', done))
    await probe('L http.request, keep-alive agent', done => {
        const request = http.request({
            host: '127.0.0.1', port, agent: new http.Agent({ keepAlive: true })
        }, response => { response.resume(); response.on('end', () => done(`status ${response.statusCode}`)) })
        request.on('error', done)
        request.end()
    })
    await probe('L fetch', done => fetch(local).then(response => response.text().then(body => done(`status ${response.status} ${body}`)), done))
    await probe('L net.connect(port, host)', done => connects(done, () => net.connect(port, '127.0.0.1')))
    await probe('L dns.lookup localhost', done => dns.lookup('localhost', (error, address) => done(error || `OK:resolved ${address}`)))

    // --- the outside world must be refused
    await probe('O http.get to an outside address', done => getBody(done, { host: OUTSIDE, port: 80 }))
    await probe('O http.get by url to an outside name', done => {
        const request = http.get('http://outside.invalid/', { timeout: 2000 }, response => {
            response.resume()
            response.on('end', () => done(`status ${response.statusCode}`))
        })
        request.on('timeout', () => request.destroy(unguarded()))
        request.on('error', done)
    })
    await probe('O http.request with an outside host', done => {
        const request = http.request({ host: OUTSIDE, port: 80, method: 'HEAD', timeout: 2000 }, response => {
            response.resume()
            response.on('end', () => done(`status ${response.statusCode}`))
        })
        request.on('timeout', () => request.destroy(unguarded()))
        request.on('error', done)
        request.end()
    })
    await probe('O https.get to an outside address', done => {
        const request = https.get({ host: OUTSIDE, port: 443, timeout: 2000 }, response => {
            response.resume()
            response.on('end', () => done(`status ${response.statusCode}`))
        })
        request.on('timeout', () => request.destroy(unguarded()))
        request.on('error', done)
    })
    await probe('O https.get with servername of an outside name', done => {
        const request = https.get({ host: OUTSIDE, port: 443, servername: 'outside.invalid', rejectUnauthorized: false, timeout: 2000 }, response => {
            response.resume()
            response.on('end', () => done(`status ${response.statusCode}`))
        })
        request.on('timeout', () => request.destroy(unguarded()))
        request.on('error', done)
    })
    await probe('O fetch to an outside address', done => fetch(`http://${OUTSIDE}/`, { signal: AbortSignal.timeout(2000) }).then(response => response.text().then(() => done(`status ${response.status}`)), done))
    await probe('O fetch to an outside name', done => fetch('https://outside.invalid/', { signal: AbortSignal.timeout(2000) }).then(response => response.text().then(() => done(`status ${response.status}`)), done))
    await probe('O net.connect(port, host)', done => outsideSocket(done, () => net.connect(80, OUTSIDE)))
    await probe('O net.createConnection({ host, port })', done => outsideSocket(done, () => net.createConnection({ host: OUTSIDE, port: 80 })))
    await probe('O new net.Socket().connect({ host, port })', done => outsideSocket(done, () => new net.Socket().connect({ host: OUTSIDE, port: 80 })))
    await probe('O new net.Socket().connect(port, host)', done => outsideSocket(done, () => new net.Socket().connect(80, OUTSIDE)))
    await probe('O new net.Socket().connect([{ host, port }])', done => outsideSocket(done, () => new net.Socket().connect([{ host: OUTSIDE, port: 80 }])))
    await probe('O tls.connect({ host, port })', done => outsideSocket(done, () => tls.connect({ host: OUTSIDE, port: 443 })))
    await probe('O tls.connect(port, host)', done => outsideSocket(done, () => tls.connect(443, OUTSIDE)))
    await probe('O http2.connect to an outside address', done => {
        const session = http2.connect(`https://${OUTSIDE}`)
        session.on('error', done)
        session.on('connect', () => { session.destroy(); done('OK:connected') })
        setTimeout(() => { session.destroy(); done(unguarded()) }, 3000).unref?.()
    })
    await probe('O dns.lookup of an outside name', done => dns.lookup('outside.invalid', (error, address) => done(error || `OK:resolved ${address}`)))
    await probe('O dns.promises.lookup of an outside name', done => dns.promises.lookup('outside.invalid').then(result => done(`OK:resolved ${JSON.stringify(result)}`), done))
    await probe('O dns.promises.resolve4 of an outside name', done => dns.promises.resolve4('outside.invalid').then(() => done('OK:resolved'), done))
    await probe('O new dns.Resolver().resolve4 of an outside name', done => new dns.Resolver().resolve4('outside.invalid', (error, addresses) => done(error || `OK:resolved ${addresses}`)))
    await probe('O new dns.promises.Resolver().resolveAny of an outside name', done => new dns.promises.Resolver().resolveAny('outside.invalid').then(() => done('OK:resolved'), done))
    await probe('O dns.promises.reverse of an outside address', done => dns.promises.reverse(OUTSIDE).then(() => done('OK:resolved'), done))
    await probe('O WebSocket to an outside address', done => {
        const socket = new WebSocket(`ws://${OUTSIDE}:80`)
        socket.addEventListener('open', () => { socket.close(); done('OK:connected') })
        socket.addEventListener('error', () => done(unguarded()))
        setTimeout(() => done(unguarded()), 3000)
    })
    try {
        const dgram = require('node:dgram')
        await probe('O dgram: a UDP socket', done => {
            const socket = dgram.createSocket('udp4')
            socket.on('error', done)
            socket.send(Buffer.from('x'), 53, OUTSIDE, error => done(error || 'OK:sent'))
        })
    } catch { /* no dgram in this runtime: nothing to probe */ }
    if (typeof globalThis.Bun?.connect === 'function') {
        await probe('O Bun.connect to an outside address', done => {
            Promise.resolve(globalThis.Bun.connect({ hostname: OUTSIDE, port: 80 })).then(socket => { socket.end(); done('OK:connected') }, done)
            setTimeout(() => done(unguarded()), 3000)
        })
    }
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))

    const leaks = results.filter(result => result.label.startsWith('O ') && !refused(result.code))
    const broken = results.filter(result => result.label.startsWith('L ') && !ok(result.code))
    if (leaks.length || broken.length) {
        for (const { label, code } of results) console.error(`net-guard self-test: ${code.padEnd(40)} ${label}`)
        const detail = [
            ...leaks.map(({ label, code }) => `not refused: ${label} (${code})`),
            ...broken.map(({ label, code }) => `loopback refused or unanswered: ${label} (${code})`)
        ].join('; ')
        throw new Error(`net-guard: the self-test failed in this runtime — ${detail}`)
    }
    return results
}

module.exports = {
    install,
    isLoopback,
    // The wraps have to be in place before anything probes them.
    selfTest: async () => { install(); return selfTest() }
}
