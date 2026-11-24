#!/usr/bin/env node
'use strict'

/**
 * What the worker's browser says about itself, per headless mode
 * (Qwen2API-3ue.4, signin-worker/lib/browser-identity.js) — measured, not
 * argued. qwen.ai is never contacted: the "chat" is a stand-in on 127.0.0.1
 * (and a second one on 127.0.0.2, to see the identity survive a change of
 * site), this process may connect to loopback only, and the document the
 * identity is read from is served inside the browser by a route.
 *
 *   bunx playwright install chromium     # once: the shell and the full Chromium
 *   node tools/worker-identity-probe.js [--playwright <dir>] [--modes shell,full,chrome]
 *                                        [--headed] [--memory]
 *
 * Modes: `shell` is what the worker runs by default, `full` the full Chromium
 * left as it is, `chrome` the worker's SIGNIN_HEADLESS_MODE=chrome — the real
 * openContext, as the worker launches it. `--headed` adds the reference, the
 * same build with a window (it needs a display); with it, every other mode is
 * listed against it field by field. `--memory` adds what each browser costs.
 * Playwright is resolved from this script's directory chain, or from
 * <dir>/node_modules. Re-run it after a Playwright upgrade: what the modes
 * claim is what this prints.
 */

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { openContext } = require('../signin-worker/lib/browser-signin')

// --- guard: this process connects to loopback only ---
const net = require('node:net')
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
    const first = args[0]
    const host = Array.isArray(first) ? first[0]
        : first && typeof first === 'object' ? first.host : first
    if (host && !/^127\./.test(host)) throw new Error(`network guard: refused ${host}`)
    return connect.apply(this, args)
}

const argument = name => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
}
const playwrightDir = argument('--playwright')
const { chromium } = playwrightDir
    ? require(path.join(playwrightDir, 'node_modules', 'playwright')) : require('playwright')
const headed = process.argv.includes('--headed')
const WANTED = (argument('--modes') || 'shell,full,chrome').split(',')
const WITH_MEMORY = process.argv.includes('--memory')

const PAGE = `<!doctype html><html><body>stand-in<script>
(async () => {
  const data = navigator.userAgentData
  const high = data ? await data.getHighEntropyValues(
    ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList']) : {}
  const post = (url, body) => fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })
  await post('/api/echo', {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    chrome: typeof window.chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    brands: data ? data.brands : null,
    mobile: data ? data.mobile : null,
    uaPlatform: data ? data.platform : null,
    ...high
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  // Read again once the window has settled: a fresh window reports 0 until it is sized.
  await post('/api/echo?late', {
    userAgent: navigator.userAgent,
    window: [outerWidth, outerHeight, innerWidth, innerHeight]
  })
})()
</script></body></html>`

const REQUEST_HEADERS = [
    'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version-list',
    'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-platform-version', 'accept-language'
]
const pick = headers => Object.fromEntries(REQUEST_HEADERS.map(name => [name, headers[name] ?? null]))

function startStandIn(host) {
    const seen = { document: null, request: null, page: null, late: null }
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/') {
            seen.document = pick(req.headers)
            res.writeHead(200, {
                'content-type': 'text/html',
                // So that the page's calls carry the hints a guard can ask for.
                'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, ' +
                    'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version'
            })
            return res.end(PAGE)
        }
        if (req.method === 'POST' && req.url.startsWith('/api/echo')) {
            seen.request ||= pick(req.headers)
            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', () => {
                seen[req.url.includes('late') ? 'late' : 'page'] = JSON.parse(body)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('{}')
            })
            return
        }
        res.writeHead(404)
        res.end()
    })
    return new Promise(resolve => server.listen(0, host, () => resolve({ server, seen,
        origin: `http://${host}:${server.address().port}` })))
}

async function settled(seen) {
    const deadline = Date.now() + 10000
    while (!seen.late && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (!seen.late) throw new Error('the page never reported')
}

// How each mode is launched. shell, chrome and headed are the worker's own
// openContext, exactly as it launches them; `full` has no worker code path.
const LAUNCHERS = {
    shell: dataDir => openContext({ dataDir, proxy: null, headless: true, launcher: chromium }),
    chrome: dataDir => openContext({ dataDir, proxy: null, headless: true, headlessMode: 'chrome', launcher: chromium }),
    headed: dataDir => openContext({ dataDir, proxy: null, headless: false, launcher: chromium }),
    full: dataDir => chromium.launchPersistentContext(dataDir, {
        headless: true, channel: 'chromium',
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        chromiumSandbox: false,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
        proxy: undefined,
        timeout: 30000
    })
}
const LABELS = {
    shell: 'shell (the worker default)', full: 'full Chromium, untouched',
    chrome: 'chrome (SIGNIN_HEADLESS_MODE=chrome)', headed: 'headed (reference)'
}

/** Memory of every process of this browser, in MiB. Read-only. */
function memoryOf(dataDir) {
    // The browser process names the profile on its command line and is the
    // only one without --type; its children do not all repeat the path.
    if (process.platform === 'win32') {
        const script = `$all = Get-CimInstance Win32_Process
$root = $all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('DATA_DIR') -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
if (-not $root) { Write-Output '0 0'; return }
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
$queue = New-Object 'System.Collections.Generic.Queue[int]'
$queue.Enqueue($root.ProcessId)
while ($queue.Count) { $id = $queue.Dequeue(); if (-not $ids.Add($id)) { continue }; foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $id })) { $queue.Enqueue($c.ProcessId) } }
$p = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
Write-Output "$(($p | Measure-Object).Count) $(($p | Measure-Object PrivatePageCount -Sum).Sum)"`.replace('DATA_DIR', dataDir)
        const file = path.join(os.tmpdir(), 'qwen-identity-probe-memory.ps1')
        fs.writeFileSync(file, script)
        let out
        try {
            out = execFileSync('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' }).trim()
        } finally {
            fs.rmSync(file, { force: true })
        }
        const [processes, privateBytes] = out.split(/\s+/).map(Number)
        return `${processes} processes, private ${Math.round(privateBytes / 2 ** 20)} MiB`
    }
    let root = null
    const parents = new Map()
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
            parents.set(Number(pid), Number(/\) \S+ (\d+)/.exec(stat)?.[1] || 0))
            const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
            if (cmdline.includes(dataDir) && !cmdline.includes('--type=')) root = Number(pid)
        } catch { /* the process left */ }
    }
    const ids = new Set()
    const queue = root ? [root] : []
    while (queue.length) {
        const id = queue.pop()
        if (ids.has(id)) continue
        ids.add(id)
        for (const [pid, ppid] of parents) if (ppid === id) queue.push(pid)
    }
    let pss = 0
    for (const pid of ids) {
        try {
            pss += Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] || 0)
        } catch { /* the process left */ }
    }
    return `${ids.size} processes, pss ${Math.round(pss / 1024)} MiB`
}

async function measure(mode) {
    const standIn = await startStandIn('127.0.0.1')
    const otherSite = await startStandIn('127.0.0.2')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-identity-probe-'))
    const started = Date.now()
    let context
    try {
        context = await LAUNCHERS[mode](dataDir)
        const launched = Date.now() - started
        const page = context.pages()[0]
        await page.goto(standIn.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        await settled(standIn.seen)
        const loaded = Date.now() - started
        const memory = WITH_MEMORY ? memoryOf(dataDir) : null
        await page.goto(otherSite.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        await settled(otherSite.seen)
        return { mode, launched, loaded, memory, pages: context.pages().length, ...standIn.seen, otherSite: otherSite.seen }
    } finally {
        if (context) await context.close().catch(() => {})
        await Promise.all([standIn, otherSite].map(item => new Promise(resolve => item.server.close(resolve))))
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
}

// What a guard can see of the page, in the order a report lists it.
const FIELDS = [
    ['request user-agent', r => r.request['user-agent']],
    ['request sec-ch-ua', r => r.request['sec-ch-ua']],
    ['request sec-ch-ua-full-version-list', r => r.request['sec-ch-ua-full-version-list']],
    ['request sec-ch-ua-platform', r => r.request['sec-ch-ua-platform']],
    ['request sec-ch-ua-platform-version', r => r.request['sec-ch-ua-platform-version']],
    ['request sec-ch-ua-arch', r => r.request['sec-ch-ua-arch']],
    ['request sec-ch-ua-bitness', r => r.request['sec-ch-ua-bitness']],
    ['request accept-language', r => r.request['accept-language']],
    ['document user-agent', r => r.document['user-agent']],
    ['document sec-ch-ua', r => r.document['sec-ch-ua']],
    ['navigator.userAgent', r => r.page.userAgent],
    ['navigator.userAgentData', r => JSON.stringify([r.page.brands, r.page.mobile, r.page.uaPlatform, r.page.architecture,
        r.page.model, r.page.platformVersion, r.page.fullVersionList])],
    ['navigator.platform', r => r.page.platform],
    ['navigator.webdriver', r => r.page.webdriver],
    ['typeof window.chrome', r => r.page.chrome],
    ['navigator.plugins', r => r.page.plugins],
    ['navigator.languages', r => JSON.stringify(r.page.languages)],
    ['hardwareConcurrency', r => r.page.hardwareConcurrency],
    ['deviceMemory', r => r.page.deviceMemory],
    ['window outer/inner', r => JSON.stringify(r.late.window)],
    ['other site: document user-agent', r => r.otherSite.document['user-agent']],
    ['other site: request user-agent', r => r.otherSite.request['user-agent']],
    ['other site: request sec-ch-ua', r => r.otherSite.request['sec-ch-ua']],
    ['other site: navigator.userAgent', r => r.otherSite.page.userAgent]
]
const show = (name, value) => console.log(`  ${name.padEnd(34)} ${value === null || value === undefined ? '(absent)' : value}`)

async function main() {
    for (const mode of WANTED) if (!LAUNCHERS[mode]) throw new Error(`Unknown mode ${mode}; known: ${Object.keys(LAUNCHERS)}`)
    const modes = [...WANTED, ...(headed && !WANTED.includes('headed') ? ['headed'] : [])]
    const results = []
    for (const mode of modes) results.push(await measure(mode))

    const playwrightVersion = require(playwrightDir
        ? path.join(playwrightDir, 'node_modules', 'playwright', 'package.json') : 'playwright/package.json').version
    console.log(`\n${process.platform} ${os.release()} ${os.arch()}; node ${process.version}; playwright ${playwrightVersion}`)
    for (const result of results) {
        console.log(`\n=== ${LABELS[result.mode]} ===`)
        console.log(`  launched / page loaded          ${result.launched} ms / ${result.loaded} ms   (${result.pages} page(s) left in the context)`)
        if (result.memory) console.log(`  memory                          ${result.memory}`)
        console.log('  -- the request the page makes --')
        for (const [name, value] of Object.entries(result.request)) show(name, value)
        console.log('  -- the document request --')
        for (const [name, read] of FIELDS.slice(8, 10)) show(name, read(result))
        console.log('  -- what page scripts see --')
        for (const [name, read] of FIELDS.slice(10, 20)) show(name, read(result))
        console.log('  -- after a navigation to another site --')
        for (const [name, read] of FIELDS.slice(20)) show(name, read(result))
    }

    const reference = results.find(result => result.mode === 'headed')
    if (reference) {
        console.log('\n=== fields that differ from the headed reference ===')
        for (const result of results) {
            if (result === reference) continue
            const differing = FIELDS.filter(([, read]) => JSON.stringify(read(result)) !== JSON.stringify(read(reference)))
                .map(([name]) => name)
            console.log(`  ${LABELS[result.mode].padEnd(38)} ${differing.length ? differing.join(', ') : 'none'}`)
        }
    }
    console.log('\n=== "Headless" anywhere in what the page shows? ===')
    for (const result of results) {
        const haystack = JSON.stringify([result.document, result.request, result.page, result.late, result.otherSite]).toLowerCase()
        console.log(`  ${LABELS[result.mode].padEnd(38)} ${haystack.includes('headless') ? 'YES' : 'no'}`)
    }
    console.log('\nIDENTITY PROBE OK — loopback only; qwen.ai was not contacted')
}

main().catch(error => {
    console.error(error.stack || error)
    process.exit(1)
})
