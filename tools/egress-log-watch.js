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
 *
 * A WAF challenge page comes under status 200 (Qwen2API-3ue.6): the worker
 * says so on the line, and this tool counts it as a challenge, not as a 200.
 *
 * Since Qwen2API-0c6 (2026-11-26) the worker says on that line what a whole
 * answer was beyond its status: a refusal qwen.ai put in the body of a 2xx by
 * its code, and an answer that is no 2xx by its code, its headers and the start
 * of its body. A refusal in the body of a 200 is counted as the refusal it is:
 * on 2026-11-26 two refused chats/new read as accepted calls here. Since
 * Qwen2API-xun and Qwen2API-nch the worker also says when it renewed a page's
 * token in place, when a navigation waited for the page's streams, and when a
 * page load waited for its turn (and when a long line of them was packed
 * closer than planned); and three of the app's own lines — an answer
 * that failed while the app handled it, and a call the app made again after
 * the relay broke — are counted as what they are, not listed as unknown.
 */

// Terminal colors, as the logger writes them on a console.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const WORKER_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (request|egress-stream|egress|resident-open|resident-close|resident-shutdown|token-refresh|resident-wait|page-load|renew|session|silent-renew|signin-worker|stopping)\b ?(.*)$/
const APP_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[(ERROR|WARN|INFO|SUCCESS|DEBUG)\] \[([^\]]+)\] ?(.*)$/
// The app's start-up record prints its flags as an object on the lines after
// it. The app runs on Bun, which quotes strings with double quotes; Node, on
// a developer's machine, with single ones.
const FLAG_LINE = /^ {2}(chatCreationTransport|completionsTransport): (["'])([a-z]+)\2,?$/

const CHATS_NEW = '/api/v2/chats/new'
// What the worker's log says of an answer that was a WAF challenge page, and
// of one the page's scripts kept from the call (the worker read it off the
// page's network): signin-worker/server.js, CHALLENGE_NOTE.
const CHALLENGE = ' — WAF challenge page'
const KEPT = ', kept from the call by the page'
const REFUSED_PREFIX = 'app.chatsNewRefused.'
// Why a resident page closes other than on purpose (evicted, shut down, proxy changed).
const PAGE_DEATHS = ['unresponsive', 'page_crashed', 'context_closed', 'keepalive_failed', 'open_failed', 'operation_failed']
const REFUSALS = ['upstream_session_unauthorized', 'upstream_waf_challenge']
// How a refusal in the body of a 2xx that names no code is counted.
const NO_CODE = 'no_code'

/** One log line, stripped of terminal colors. */
const plain = line => line.replace(ANSI, '')

/** What a summary starts from. */
const newReport = () => ({
    first: null, last: null, lines: { worker: 0, app: 0, other: 0 },
    counts: new Map(), unknown: new Map(), flags: null, browser: null, pages: { peak: 0, cap: 0 },
    // How long the worker's waits were: for a turn to load a page, and of a navigation for the page's streams.
    waits: { load: 0, loadLongest: 0, stream: 0, streamLongest: 0 }
})

function bump(report, name, by = 1) {
    report.counts.set(name, (report.counts.get(name) || 0) + by)
}

function note(report, at) {
    if (!report.first || at < report.first) report.first = at
    if (!report.last || at > report.last) report.last = at
}

/**
 * What a line's note makes of a 200: the name of a WAF challenge page, or
 * nothing for an ordinary answer.
 * @param {string} [said] - What the worker wrote after the status
 * @returns {string|null}
 */
const challengeName = said => {
    if (!said || !said.startsWith(CHALLENGE)) return null
    return said.slice(CHALLENGE.length).startsWith(KEPT) ? 'challenge.kept' : 'challenge'
}

/**
 * A refusal qwen.ai put in the body of a whole answer, as the worker's line
 * says of it (Qwen2API-0c6): by its code ("code …"), or, one that names none,
 * by being one ("refused, no code"). Null when the line says neither. An
 * answer of a 2xx carries one note and no more — no headers, no body — so the
 * code is the whole rest of the line, whatever is in it.
 * @param {string} [said] - What the worker wrote after " — "
 * @returns {{code: string}|null}
 */
function bodyRefusal(said) {
    if (!said) return null
    if (said.startsWith('code ')) return { code: said.slice(5).trim().slice(0, 80) }
    return said === 'refused, no code' ? { code: NO_CODE } : null
}

function readWorkerLine(report, event, detail) {
    report.lines.worker++
    let found
    switch (event) {
        case 'egress': {
            if ((found = /^(\S+) -> (\d{3}) \((\d+)\/(\d+) pages\)( — (.+))?$/.exec(detail))) {
                const name = found[1] === CHATS_NEW ? 'chatsNew' : found[1]
                const challenge = challengeName(found[5])
                const refusal = challenge ? null : bodyRefusal(found[6])
                // A refusal in the body of a 2xx is counted as the refusal it is, and not as a 200 (Qwen2API-0c6).
                if (challenge) bump(report, `egress.${name}.${challenge}`)
                else if (refusal && found[2][0] === '2') bump(report, `egress.${name}.refused.${refusal.code}`)
                else bump(report, `egress.${name}.${found[2]}`)
                report.pages.peak = Math.max(report.pages.peak, Number(found[3]))
                report.pages.cap = Number(found[4])
            } else bump(report, 'unparsed.worker')
            return
        }
        case 'egress-stream':
            if ((found = /^(\S+) -> (\d{3}) \(/.exec(detail))) bump(report, `stream.head.${found[2]}`)
            else if ((found = /^(\S+) end \(\d+ ms\)( — (.+))?$/.exec(detail))) {
                bump(report, challengeName(found[2]) ? `stream.${challengeName(found[2])}` : 'stream.ended')
            } else if (/^(\S+) cancelled \(/.test(detail)) bump(report, 'stream.cancelled')
            else if ((found = /^(\S+) ([a-z_]+) \(/.exec(detail))) bump(report, `stream.failed.${found[2]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'request':
            // The app's calls are POSTs to a route; anything else that reached the
            // worker is listed under "other".
            if ((found = /^(\w+) (\S+) -> (\d{3}) /.exec(detail))) {
                const route = found[1] === 'POST' && /^\/\w+$/.test(found[2]) ? found[2].slice(1) : 'other'
                bump(report, `workerHttp.${route}.${found[3]}`)
            } else bump(report, 'unparsed.worker')
            return
        case 'resident-open':
            if ((found = /^ok \((\d+)\/(\d+) pages, front-end (\S+)\)$/.exec(detail))) {
                bump(report, 'pages.opened')
                // What front end the page runs, as the address of its scripts shows it.
                bump(report, `pages.frontEnd.${found[3]}`)
                report.pages.peak = Math.max(report.pages.peak, Number(found[1]))
                report.pages.cap = Number(found[2])
            } else bump(report, 'unparsed.worker')
            return
        case 'resident-close':
            if ((found = /^([a-z_]+) \(/.exec(detail))) bump(report, `pages.closed.${found[1]}`)
            else bump(report, 'unparsed.worker')
            return
        case 'token-refresh': {
            // The page's token, renewed in place (Qwen2API-xun). Of a failure, why — by what the line says before the time it took.
            if (/^ok \(/.test(detail)) bump(report, 'tokenRefresh.ok')
            else if ((found = /^failed \((.+?), \d+ ms(?:, after a wait of \d+ ms)?\)$/.exec(detail))) {
                bump(report, `tokenRefresh.failed.${/^(refused|network_error|timeout|aborted|page_error)/.exec(found[1])?.[1] || 'no answer'}`)
            } else bump(report, 'unparsed.worker')
            return
        }
        case 'resident-wait': {
            // A navigation waited for the streams on its page (Qwen2API-nch): until they ended, or until its limit.
            if ((found = /^(ended|(\d+) still running) \(waited (\d+) ms for the page's streams\)$/.exec(detail))) {
                bump(report, found[1] === 'ended' ? 'pageWait.ended' : 'pageWait.timedOut')
                report.waits.stream++
                report.waits.streamLongest = Math.max(report.waits.streamLongest, Number(found[3]))
            } else bump(report, 'unparsed.worker')
            return
        }
        case 'page-load': {
            // A page load waited for the worker's turn (Qwen2API-nch, Qwen2API-ops). A
            // line longer than its limit is packed closer, and the line says so.
            if ((found = /^waited \((\d+) ms(, a long line packed)?\)$/.exec(detail))) {
                bump(report, 'pageLoad.waits')
                if (found[2]) bump(report, 'pageLoad.packed')
                report.waits.load++
                report.waits.loadLongest = Math.max(report.waits.loadLongest, Number(found[1]))
            } else bump(report, 'unparsed.worker')
            return
        }
        case 'resident-shutdown':
            bump(report, 'pages.shutdown')
            return
        case 'renew':
            if (/^ok \(forced\)/.test(detail)) bump(report, 'renew.forced')
            else if (/^ok \(/.test(detail)) bump(report, 'renew.live')
            // The session turned live while the renewal waited for the account's page: nothing was loaded for it.
            else if (/^no reload \(/.test(detail)) bump(report, 'renew.answered')
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
    if ((found = /^Qwen chat creation failed: category=([a-z0-9_]+)/.exec(message))) {
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
    } else if (message === '聊天处理错误') {
        // An answer failed while the app was handling it (src/controllers/chat.js): one it had
        // begun to hand to its client ends in an error frame. The error is on the lines after.
        bump(report, 'app.chatFailed')
    } else if (message === '非流式聊天处理错误') {
        // The same of an answer without a stream: the client gets a 502.
        bump(report, 'app.wholeAnswerFailed')
    } else if (message.startsWith('聊天请求传输错误')) {
        // A call the app makes once more, nothing having reached its client yet (src/utils/request.js).
        bump(report, 'app.retried')
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
            report.flags = { ...(report.flags || {}), [found[1]]: found[3] }
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
    const otherwise = [...report.counts.keys()]
        .filter(name => name.startsWith(REFUSED_PREFIX) && !REFUSALS.includes(name.slice(REFUSED_PREFIX.length)))
        .sort()
    if (otherwise.length) {
        why.push(`chats/new failed otherwise: ${
            otherwise.map(name => `${name.slice(REFUSED_PREFIX.length)} ${count(name)}`).join(', ')}`)
    }
    // A refusal qwen.ai put in the body of a 2xx (Qwen2API-0c6): invisible until the worker said it.
    // The name is egress.<path>.refused.<code>, and neither a path nor a code is without dots.
    const inBody = []
    for (const [name, hits] of report.counts) {
        const at = name.indexOf('.refused.')
        if (name.startsWith('egress.') && at > 'egress.'.length) inBody.push([name.slice('egress.'.length, at), name.slice(at + '.refused.'.length), hits])
    }
    if (inBody.length) {
        // Said by the path, as the other complaints say chats/new.
        const said = path => (path === 'chatsNew' ? 'chats/new' : path)
        why.push(`qwen.ai refused ${inBody.reduce((sum, [, , hits]) => sum + hits, 0)} call(s) in the body of a 2xx: ${
            inBody.map(([path, code, hits]) => `${said(path)} ${code} ${hits}`).join(', ')}`)
    }
    if (total(report, 'app.workerRefused.')) why.push(`the worker could not serve ${total(report, 'app.workerRefused.')} call(s)`)
    // What the app answers its client with when a page was reloaded under its answer, and the relay broke (Qwen2API-nch).
    const failedAnswers = count('app.chatFailed') + count('app.wholeAnswerFailed')
    if (failedAnswers) {
        why.push(`${failedAnswers} answer(s) failed while the application handled them: ` +
            `${count('app.chatFailed')} with a stream, ${count('app.wholeAnswerFailed')} without`)
    }
    // The worker's own answer to an egress call that was not a success. The app's
    // line says which code when the app's log is in the feed; the worker's alone still says it happened.
    const notServed = [...report.counts].filter(([name]) => /^workerHttp\.egress\.([3-5]\d\d)$/.test(name))
    if (notServed.length) {
        const statuses = notServed.map(([name]) => name.slice('workerHttp.egress.'.length)).sort().join(' and ')
        why.push(`the worker answered ${notServed.reduce((sum, [, hits]) => sum + hits, 0)} egress call(s) with HTTP ${statuses}`)
    }
    if (total(report, 'stream.failed.')) why.push(`${total(report, 'stream.failed.')} stream(s) ended with an error`)
    // Status 200, and a page: qwen.ai asked for a verification. Counted by
    // itself — a 200 reads as nothing wrong.
    const challenges = [...report.counts].filter(([name]) => /^egress\..*\.challenge(\.kept)?$/.test(name))
    const challenged = challenges.reduce((sum, [, hits]) => sum + hits, 0) + count('stream.challenge') + count('stream.challenge.kept')
    const kept = challenges.filter(([name]) => name.endsWith('.kept')).reduce((sum, [, hits]) => sum + hits, 0) +
        count('stream.challenge.kept')
    if (challenged) {
        why.push(`qwen.ai answered ${challenged} call(s) with a WAF challenge page under status 200` +
            (kept ? `; the page's scripts kept ${kept} of them from the call (the worker read those off its network)` : ''))
    }
    if (count('pages.frontEnd.unknown')) {
        why.push(`${count('pages.frontEnd.unknown')} resident page(s) showed no front-end version: their calls carry no version header`)
    }
    // What qwen.ai answered.
    for (const [name, hits] of report.counts) {
        const found = /^(egress\..+|stream\.head)\.([1-5]\d\d)$/.exec(name)
        if (!found || found[2] === '200' || (found[1] === 'stream.head' && found[2] === '401')) continue
        why.push(`${name}: ${hits}`)
    }
    // A 401 head of a stream is the app's to recover from inside the request (one
    // reload, one retry), so one is counted and not complained of. Refused more
    // often than accepted is the shape of 23.11: every call refused, the page
    // reloaded for each, refused again. A challenged stream is no accepted one.
    const refused = count('stream.head.401')
    const accepted = count('stream.head.200') - count('stream.challenge') - count('stream.challenge.kept')
    if (refused > accepted) why.push(`streams refused as 401 more often than accepted: ${refused} refused, ${accepted} accepted`)
    if (count('renew.forced') && total(report, 'stream.head.') && !count('stream.ended')) {
        why.push(`${count('renew.forced')} forced reload(s), and not one stream finished`)
    }
    if (total(report, 'app.recoveryFailed.') || total(report, 'silentRenew.failed.')) {
        why.push(`a refused session was not replaced: recovery failed ${total(report, 'app.recoveryFailed.')}, silent renewal failed ${total(report, 'silentRenew.failed.')}`)
    }
    // A page's token the worker could not renew in place (Qwen2API-xun): the call went out on the old one.
    if (total(report, 'tokenRefresh.failed.')) {
        why.push(`a page's token was not renewed ${total(report, 'tokenRefresh.failed.')} time(s)`)
    }
    // A line of page loads longer than its limit (lib/page-load-queue.js): more loads at once than
    // the spacing fits in it, so they began closer to each other than planned.
    if (count('pageLoad.packed')) why.push(`${count('pageLoad.packed')} page load(s) began closer than planned: the line was longer than its limit`)
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
    section("the page's token, renewed in place", 'tokenRefresh.')
    section('navigations that waited for the page’s streams', 'pageWait.')
    section('page loads that waited for a turn', 'pageLoad.')
    if (report.waits.load) out.push(`longest wait for a turn to load a page: ${report.waits.loadLongest} ms`)
    if (report.waits.stream) out.push(`longest a navigation waited for the page's streams: ${report.waits.streamLongest} ms`)
    section('other', 'worker.')
    section('other', 'unparsed.')
    out.push(`resident pages at most at once: ${report.pages.peak}${report.pages.cap ? ` of ${report.pages.cap}` : ''}`)
    if (report.unknown.size) {
        out.push('app errors and warnings this tool does not know (first 10):')
        for (const [shape, hits] of [...report.unknown].slice(0, 10)) out.push(`    ${hits}x  ${shape}`)
    }
    const why = complaints(report)
    let verdict = 'OK'
    if (why.length) verdict = 'LOOK'
    // Without any, there is nothing to judge the egress by: a start-up line alone
    // says nothing about what qwen.ai did.
    else {
        const judged = total(report, 'egress.') + total(report, 'stream.') + total(report, 'workerHttp.egress.') +
            total(report, 'app.') - count('app.started')
        if (!judged) verdict = 'NOTHING TO JUDGE'
    }
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
