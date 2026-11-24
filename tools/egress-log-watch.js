#!/usr/bin/env node
'use strict'

/**
 * Reads the logs of the signin worker and of the app and says what qwen.ai
 * did with the browser egress (Qwen2API-3ue.4). The hour of watching that
 * decides whether the epic is done is a count, not an impression.
 *
 *   docker logs --since 1h <signin-worker container> 2>&1 | node tools/egress-log-watch.js
 *   docker logs --since 1h <qwen2api container>     2>&1 | node tools/egress-log-watch.js
 *   cat worker.log app.log | node tools/egress-log-watch.js      # any mix, any order
 *
 * Lines are told apart by their shape. It ends with a verdict and leaves its
 * code behind: 0 = OK, 1 = look at this, 2 = nothing to judge. It reads text
 * and does nothing else: no network, no container access of its own. What it
 * does not recognize among the app's errors is listed rather than dropped.
 */

// Terminal colors, as the logger writes them on a console.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const WORKER_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (request|egress-stream|egress|resident-open|resident-close|resident-shutdown|renew|session|silent-renew|signin-worker|stopping)\b ?(.*)$/
const APP_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[(ERROR|WARN|INFO|SUCCESS|DEBUG)\] \[([^\]]+)\] ?(.*)$/
// The app's startup record prints its flags as an object on the lines after it.
const FLAG_LINE = /^ {2}(chatCreationTransport|completionsTransport): '([a-z]+)',?$/

const CHATS_NEW = '/api/v2/chats/new'
// Why a resident page closes other than on purpose (evicted, shut down, proxy changed).
const PAGE_DEATHS = ['unresponsive', 'page_crashed', 'context_closed', 'keepalive_failed', 'open_failed', 'operation_failed']
const REFUSALS = ['upstream_session_unauthorized', 'upstream_waf_challenge']

/** One log line, stripped of terminal colors. */
const plain = line => line.replace(ANSI, '')

/** What a summary starts from. */
const newReport = () => ({
    first: null, last: null, lines: { worker: 0, app: 0, other: 0 },
    counts: new Map(), unknown: new Map(), flags: null, browser: null, pages: { peak: 0, cap: 0 }
})

function bump(report, name, by = 1) {
    report.counts.set(name, (report.counts.get(name) || 0) + by)
}

function note(report, at) {
    if (!report.first || at < report.first) report.first = at
    if (!report.last || at > report.last) report.last = at
}

function readWorkerLine(report, event, detail) {
    report.lines.worker++
    let found
    switch (event) {
        case 'egress':
            if ((found = /^(\S+) -> (\d{3}) \((\d+)\/(\d+) pages\)$/.exec(detail))) {
                bump(report, `egress.${found[1] === CHATS_NEW ? 'chatsNew' : found[1]}.${found[2]}`)
                report.pages.peak = Math.max(report.pages.peak, Number(found[3]))
                report.pages.cap = Number(found[4])
            } else bump(report, 'unparsed.worker')
            return
        case 'egress-stream':
            if ((found = /^(\S+) -> (\d{3}) \(/.exec(detail))) bump(report, `stream.head.${found[2]}`)
            else if (/^(\S+) end \(/.test(detail)) bump(report, 'stream.ended')
            else if (/^(\S+) cancelled \(/.test(detail)) bump(report, 'stream.cancelled')
            else if ((found = /^(\S+) ([a-z_]+) \(/.exec(detail))) bump(report, `stream.failed.${found[2]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'request':
            if ((found = /^POST (\/\w+) -> (\d{3}) /.exec(detail))) bump(report, `workerHttp.${found[1].slice(1)}.${found[2]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'resident-open':
            if ((found = /^ok \((\d+)\/(\d+) pages\)$/.exec(detail))) {
                bump(report, 'pages.opened')
                report.pages.peak = Math.max(report.pages.peak, Number(found[1]))
                report.pages.cap = Number(found[2])
            } else bump(report, 'unparsed.worker')
            return
        case 'resident-close':
            if ((found = /^([a-z_]+) \(/.exec(detail))) bump(report, `pages.closed.${found[1]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'resident-shutdown':
            bump(report, 'pages.shutdown')
            return
        case 'renew':
            if (/^ok \(forced\)/.test(detail)) bump(report, 'renew.forced')
            else if (/^ok \(/.test(detail)) bump(report, 'renew.live')
            else bump(report, 'unparsed.worker')
            return
        case 'session':
            if ((found = /^(acquired|queued|cached|joined)\b/.exec(detail))) bump(report, `signin.${found[1]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'silent-renew':
            if ((found = /^failed \((\w+)\)/.exec(detail))) bump(report, `silentRenew.failed.${found[1]}`)
            else if (/^ok/.test(detail)) bump(report, 'silentRenew.ok')
            else bump(report, 'unparsed.worker')
            return
        case 'signin-worker':
            if ((found = /\(browser: (.+)\)$/.exec(detail))) {
                bump(report, 'worker.started')
                report.browser = found[1]
            }
            return
        default:
            bump(report, 'worker.stopping')
    }
}

function readAppLine(report, level, message) {
    report.lines.app++
    // The logger puts its emoji in front of the message, and no message starts
    // with something that is not a letter, a digit or a quote.
    const first = /^\S+/.exec(message)?.[0]
    if (first && !/[\p{L}\p{N}"'`]/u.test(first)) message = message.slice(first.length).trimStart()
    let found
    if ((found = /^Qwen chat creation failed: category=([a-z_]+)/.exec(message))) {
        bump(report, `app.chatsNewRefused.${found[1]}`)
    } else if (message.includes('chats/new через signin-worker не прошёл')) {
        bump(report, `app.workerRefused.chatsNew.${(/\(([a-z_]+)\)/.exec(message) || [null, 'unreachable'])[1]}`)
    } else if (message.includes('completions через signin-worker не прошёл')) {
        bump(report, `app.workerRefused.completions.${(/\(([a-z_]+)\)/.exec(message) || [null, 'unreachable'])[1]}`)
    } else if (message.includes('v2 会话已续期')) {
        bump(report, 'app.recovered')
    } else if (message.includes('v2 会话续期失败')) {
        bump(report, `app.recoveryFailed.${(/\): ([A-Za-z_]+)/.exec(message) || [null, 'error'])[1]}`)
    } else if (message.includes('v2 会话失效')) {
        bump(report, 'app.sessionDropped')
    } else if (message.includes('v2 полный вход отложен')) {
        bump(report, 'app.reloginDeferred')
    } else if (message.includes('v2 полный вход невозможен')) {
        bump(report, 'app.reloginImpossible')
    } else if (message.includes('服务器启动成功') || message.includes('v2 会话恢复完成')) {
        bump(report, 'app.started')
    } else if (level === 'ERROR' || level === 'WARN') {
        bump(report, `app.unclassified.${level}`)
        // What the message is, without the account in it: a log owes nobody those.
        const shape = message.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<account>').slice(0, 160)
        report.unknown.set(shape, (report.unknown.get(shape) || 0) + 1)
    }
}

/** Feed it lines; it returns the report. */
function summarize(lines, report = newReport()) {
    for (const raw of lines) {
        const line = plain(raw).replace(/\r$/, '')
        let found
        if ((found = WORKER_LINE.exec(line))) {
            note(report, found[1])
            readWorkerLine(report, found[2], found[3])
        } else if ((found = APP_LINE.exec(line))) {
            // The app's clock is local time without a zone: it does not feed the window.
            readAppLine(report, found[2], found[4])
        } else if ((found = FLAG_LINE.exec(line))) {
            report.flags = { ...(report.flags || {}), [found[1]]: found[2] }
        } else if (line.trim()) {
            report.lines.other++
        }
    }
    return report
}

const total = (report, prefix) => [...report.counts]
    .filter(([name]) => name.startsWith(prefix)).reduce((sum, [, count]) => sum + count, 0)

/** The window the worker's logs cover, in minutes; at least one, so a lone line is not a rate. */
function minutesOf(report) {
    if (!report.first || !report.last) return null
    return Math.max(1, (Date.parse(report.last) - Date.parse(report.first)) / 60000)
}

/** Why this is not OK, in the order an operator should look at it. */
function complaints(report) {
    const count = name => report.counts.get(name) || 0
    const minutes = minutesOf(report)
    const why = []
    for (const code of REFUSALS) {
        if (count(`app.chatsNewRefused.${code}`)) why.push(`qwen.ai refused chats/new as ${code}: ${count(`app.chatsNewRefused.${code}`)}`)
    }
    // Any other way chats/new failed (a 409 with no session, an answer of an unknown shape, a quota):
    // in an hour through the pages there is no such thing as a harmless one.
    const otherwise = [...report.counts.keys()].filter(name => name.startsWith('app.chatsNewRefused.') && !REFUSALS.includes(name.slice(18)))
    if (otherwise.length) why.push(`chats/new failed otherwise: ${otherwise.map(name => `${name.slice(18)} ${count(name)}`).join(', ')}`)
    if (total(report, 'app.workerRefused.')) why.push(`the worker could not serve ${total(report, 'app.workerRefused.')} call(s)`)
    if (total(report, 'stream.failed.')) why.push(`${total(report, 'stream.failed.')} stream(s) ended with an error`)
    // What qwen.ai answered. A 401 head of a stream is the app's to recover from
    // inside the request (one reload, one retry), so it is counted, not complained of.
    for (const [name, hits] of report.counts) {
        const found = /^(egress\..+|stream\.head)\.([1-5]\d\d)$/.exec(name)
        if (!found || found[2] === '200' || (found[1] === 'stream.head' && found[2] === '401')) continue
        why.push(`${name}: ${hits}`)
    }
    if (total(report, 'app.recoveryFailed.') || total(report, 'silentRenew.failed.')) {
        why.push(`a refused session was not replaced: recovery failed ${total(report, 'app.recoveryFailed.')}, silent renewal failed ${total(report, 'silentRenew.failed.')}`)
    }
    const died = PAGE_DEATHS.reduce((sum, reason) => sum + count(`pages.closed.${reason}`), 0)
    if (died) why.push(`${died} resident page(s) died (not evicted or shut down)`)
    // Per account the limits are one reload in 30 s and one sign-in in 60 s; logs
    // name no account, so this is the weaker bound over all of them together.
    if (minutes !== null) {
        if (count('renew.forced') > Math.max(1, Math.floor(minutes * 2))) {
            why.push(`${count('renew.forced')} forced reloads in ${minutes.toFixed(1)} min: more than one in 30 s`)
        }
        if (count('signin.acquired') > Math.max(1, Math.floor(minutes))) {
            why.push(`${count('signin.acquired')} full sign-ins in ${minutes.toFixed(1)} min: more than one in 60 s`)
        }
    }
    if (count('app.unclassified.ERROR')) why.push(`${count('app.unclassified.ERROR')} error line(s) this tool does not know (listed below)`)
    if (total(report, 'unparsed.')) why.push(`${total(report, 'unparsed.')} line(s) of a shape this tool does not know`)
    return why
}

const listing = (report, prefix) => [...report.counts]
    .filter(([name]) => name.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `    ${name.slice(prefix.length)}  ${count}`)
    .join('\n')

/** The report as text, and its verdict. */
function render(report) {
    const count = name => report.counts.get(name) || 0
    const minutes = minutesOf(report)
    const out = []
    out.push(`lines: ${report.lines.worker} from the worker, ${report.lines.app} from the app, ${report.lines.other} other`)
    if (minutes !== null) out.push(`window: ${report.first} .. ${report.last} (${minutes.toFixed(1)} min)`)
    const flags = report.flags
        ? `chats/new=${report.flags.chatCreationTransport || '?'}, completions=${report.flags.completionsTransport || '?'}`
        : 'not in these logs'
    out.push(`flags at the app's start: ${flags}; worker browser: ${report.browser || 'not in these logs'}`)
    const section = (title, prefix) => {
        if (!total(report, prefix)) return
        out.push(title)
        out.push(listing(report, prefix))
    }
    section('qwen.ai calls from the pages', 'egress.')
    section('completions streams', 'stream.')
    section("the worker's own HTTP answers", 'workerHttp.')
    section('what the app made of it', 'app.')
    for (const prefix of ['renew.', 'signin.', 'silentRenew.']) {
        if (total(report, prefix)) {
            out.push('sessions')
            out.push(listing(report, prefix))
        }
    }
    section('resident pages', 'pages.')
    section('other', 'worker.')
    section('other', 'unparsed.')
    out.push(`resident pages at most at once: ${report.pages.peak}${report.pages.cap ? ` of ${report.pages.cap}` : ''}`)
    if (report.unknown.size) {
        out.push('app errors and warnings this tool does not know (first 10):')
        for (const [shape, hits] of [...report.unknown].slice(0, 10)) out.push(`    ${hits}x  ${shape}`)
    }
    const why = complaints(report)
    let verdict = 'OK'
    // A start-up line alone says nothing about what qwen.ai did.
    const judged = total(report, 'egress.') + total(report, 'stream.') + total(report, 'app.') - count('app.started')
    if (!judged) verdict = 'NOTHING TO JUDGE'
    else if (why.length) verdict = 'LOOK'
    out.push(`verdict: ${verdict}${why.length ? `\n  - ${why.join('\n  - ')}` : ''}`)
    return { text: out.join('\n'), verdict, why }
}

async function main() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const report = summarize(Buffer.concat(chunks).toString('utf8').split('\n'))
    const { text, verdict } = render(report)
    console.log(text)
    process.exitCode = verdict === 'OK' ? 0 : verdict === 'LOOK' ? 1 : 2
}

module.exports = { summarize, render, complaints, plain }

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error)
        process.exitCode = 1
    })
}
