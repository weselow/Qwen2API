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
 *
 * Since Qwen2API-jk9 (2026-11-27) the two lines of a whole answer asked for
 * once more are counted the same way: one request without a stream whose
 * first attempt died before a byte reached its client is made again —
 * `app.wholeAnswerRetry`, by why —, and its answer is delivered —
 * `app.wholeAnswerRetry.delivered`. They are a symptom, not a verdict: what
 * broke is said by the lines that already make the verdict (a stream that
 * ended with an error, an answer that failed under the application), and a
 * retry that was not delivered is not a failure by itself — its client may
 * have gone away while it was under way.
 *
 * Since Qwen2API-j5f (2026-11-28) it knows what the logs of 27.11 showed,
 * and names it instead of listing it as unknown. Of the app: a picture or a
 * video whose generation failed — explained when the worker's log says a
 * navigation's wait ran out from 30 s before the app's line to a second
 * after it (a reload under its limit cutting the generation; the client
 * gets a 503), and said when nothing does; a chat request that failed on
 * every attempt, by what qwen.ai answered, by quota, or by the worker's
 * code; a model with no MODEL_MAP entry; a session that was not saved; an
 * answer that failed on the Anthropic route, said with the others; and
 * requests the app ended because their account was removed meanwhile:
 * each writes a WARN and up to two ERROR lines after it — the chat that
 * could not be made, and whatever its handler writes —, read as that
 * request's echo while each comes within two seconds of the one before,
 * counted under the removal, and no complaint. Requests that continue
 * together in one turn of the event loop — two that waited on one renewal
 * write WARN, WARN, chats/new, chats/new, handler, handler — are told
 * apart by a count of what is due, not by one chain. Of the worker: what
 * became of a forgotten account's browser profile, by outcome, and a
 * profile that could not be removed said so; and a 504 of an egress call
 * by how long the call waited, against the limits the app gives its calls:
 * under five minutes a call that did not return from the page in time
 * (chats/new's own limit is half a minute), from five minutes a picture or
 * video generation that did not finish, from ten minutes completions giving
 * no head. The app's clock carries no zone: its lines are read as UTC, the
 * host's time that both containers take.
 */

// Terminal colors, as the logger writes them on a console.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const WORKER_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (request|egress-stream|egress|resident-open|resident-close|resident-shutdown|token-refresh|resident-wait|page-load|renew|session|silent-renew|signin-worker|stopping|forget)\b ?(.*)$/
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
const CHAT_REQUEST_FAILED = 'app.chatRequestFailed.'
// How long before an app line a navigation's wait that ran out may lie and still be the reload
// that cut the picture or the video the line is about: that long after the worker gave up
// waiting, the app may still be writing its error (a slow reload).
const MEDIA_CUT_BEFORE_MS = 30000
// ...and how long after it: the app writes its lines to the second, the worker to the millisecond.
const MEDIA_CUT_AFTER_MS = 1000
// An egress call the worker answered with a 504, by the limit the app gave the call — the line says
// only how long it waited (src/utils/browser-egress.js, src/controllers/chat.image.video.js): chats/new
// and the JSON calls have half a minute (CHAT_TIMEOUT_MS, JSON_TIMEOUT_MS), a picture or video
// generation five minutes (GENERATION_TIMEOUT_MS), completions ten (COMPLETIONS_TIMEOUT_MS). A slow
// page opening adds to any of them. The values are the app's: tests/egress-log-watch.test.js reads
// them off its source, and fails when one moves.
const GENERATION_LIMIT_MS = 5 * 60 * 1000
const COMPLETIONS_LIMIT_MS = 10 * 60 * 1000
// How long after the last line of the echo of a removed account's request its next line may come: the
// lines of one request are written in one turn of the event loop, and share a second of the app's clock
// except across a boundary.
const REMOVED_ECHO_MS = 2000
// The app's WARN that it ended a request because its account was removed meanwhile
// (src/utils/browser-egress.js#removedRequest); the account stands in the brackets.
const REMOVED_REQUEST = 'The account was removed from the app while its request was out on it; the request ends here ('
// What the app writes of a picture or a video that failed while it handled the request
// (src/controllers/chat.image.video.js): the request for the generation itself failing —
// which the cut of a video always writes, its answer being read whole inside that request —,
// the main flow's line, and the line of the route that asked: the OpenAI endpoints of image
// generation, image edit and video generation, and the image/video chat route. Seen live on
// 27.11: the pair of image generation. The rest is the same family by the code, and by its
// handlers run on 28.11: an edit writes the pair of its endpoint, a video three lines.
const MEDIA_FAILED = [
    '图片/视频请求失败', '图片/视频主流程异常', 'OpenAI 图片生成端点处理失败', 'OpenAI 图片编辑端点处理失败',
    'OpenAI 视频生成端点处理失败', '图片视频资源处理错误'
]

/**
 * An app line's time — local time with no zone — read as UTC, the host's
 * time that both containers take on production. Not Date.parse: of a string
 * without a zone it makes the machine's own, and on a developer's machine
 * the moment moves by hours.
 * @param {string} at - `YYYY-MM-DD HH:MM:SS`, as APP_LINE reads it
 * @returns {number} milliseconds of the epoch
 */
function appTime(at) {
    const [date, time] = at.split(' ')
    const [year, month, day] = date.split('-').map(Number)
    const [hour, minute, second] = time.split(':').map(Number)
    return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** One log line, stripped of terminal colors. */
const plain = line => line.replace(ANSI, '')

/** What a summary starts from. */
const newReport = () => ({
    first: null, last: null, lines: { worker: 0, app: 0, other: 0 },
    counts: new Map(), unknown: new Map(), flags: null, browser: null, pages: { peak: 0, cap: 0 },
    // How long the worker's waits were: for a turn to load a page, and of a navigation for the page's streams.
    waits: { load: 0, loadLongest: 0, stream: 0, streamLongest: 0 },
    // When the worker's waits for a page's streams ran out under an answer, on the worker's clock; and when
    // the app said a picture or a video failed, on its own. The one is matched against the other when the
    // feed is over (judgeMediaFailures). Not printed.
    cutWaits: [], mediaFailures: [],
    // What is due of the echo of the requests the app ended because their account was removed (Qwen2API-u50):
    // how many chats/new lines, how many handler's lines, and when the last line of the run came on the
    // app's clock — or null when no such request is being read (readRemovedEcho). Not printed.
    removedEcho: null,
    // A chat request failed and its message is on the next line (src/utils/request.js): that line is waited for.
    chatRequestMessage: false
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

/**
 * Of the app's lines that say a picture or a video failed, which are what a
 * navigation's wait that ran out cut — the worker's `resident-wait N still
 * running`, from MEDIA_CUT_BEFORE_MS before the app's line to
 * MEDIA_CUT_AFTER_MS after it — and which are failures of their own, said so.
 * Judged when the feed is over, by time and never by the order of the feed:
 * the two logs may come in either order, or interleaved.
 * @param {object} report
 */
function judgeMediaFailures(report) {
    for (const time of report.mediaFailures) {
        const cut = report.cutWaits.some(wait => time - MEDIA_CUT_BEFORE_MS <= wait && wait <= time + MEDIA_CUT_AFTER_MS)
        bump(report, cut ? 'app.mediaCutByReload' : 'app.mediaFailed')
    }
    report.mediaFailures = []
}

/**
 * The kind of a failed chat request whose message came on the line after
 * (src/utils/request.js): qwen.ai's status when it is axios's "Request
 * failed with status code N" — as the console prints it, or under the quotes
 * the file log puts round a string —; else "other".
 * @param {object} report
 * @param {string|null} said - The line after, or null when the feed ended on the bare line
 */
function saidChatRequestFailure(report, said) {
    const found = said && /^"?Request failed with status code (\d{3})"?$/.exec(said)
    bump(report, `app.chatRequestFailed.${found ? found[1] : 'other'}`)
}

/**
 * The echo of the requests the app ended because their account was removed
 * meanwhile (Qwen2API-u50). Each request writes a WARN, then up to two
 * ERROR lines: the chat that could not be made, and whatever its handler
 * writes. Requests of one account that waited on one renewal continue in one
 * turn of the event loop, and write WARN, WARN, chats/new, chats/new,
 * handler, handler: so what is due is counted, not followed as one chain.
 * The WARN adds one to the chats/new lines due. An ERROR line of that shape,
 * while one is due, is counted under the removal and makes a handler's line
 * due; any ERROR line of the app's while one of those is due is counted the
 * same way. With nothing due the run takes no line; the next line of it
 * must come within REMOVED_ECHO_MS of the last. Any other line of the app's
 * closes it. A line of neither side's log, or the worker's, does not: in one
 * feed of both, a line of the app's stdout may land between its lines on stderr.
 * @param {object} report
 * @param {string} level - The line's level
 * @param {string} message - The line's message, its emoji off
 * @param {string} at - The line's time on the app's clock
 * @param {boolean} opens - Whether the line is the WARN that ends a request
 * @returns {boolean} Whether the line was read as the echo's, and nothing more is to be read of it
 */
function readRemovedEcho(report, level, message, at, opens) {
    const time = report.removedEcho || opens ? appTime(at) : null
    if (report.removedEcho && (time - report.removedEcho.at > REMOVED_ECHO_MS || (level !== 'ERROR' && !opens))) {
        // Too late, or no line of the echo: the run is over, whatever this line is.
        report.removedEcho = null
    }
    if (opens) {
        // One request more of the removed account: its chats/new line is due.
        const due = report.removedEcho || { chatsNew: 0, handler: 0 }
        report.removedEcho = { chatsNew: due.chatsNew + 1, handler: due.handler, at: time }
        return false
    }
    const run = report.removedEcho
    if (!run) return false
    if (run.chatsNew > 0 && message.startsWith('Qwen chat creation failed: category=upstream_transport_error')) {
        // Only that category: the error a removed account's request throws is the transport one, status 503.
        bump(report, 'app.removedAccount.chatsNew')
        run.chatsNew--
        run.handler++
    } else if (run.handler > 0) {
        // The handler's line, whatever the route wrote — `聊天处理错误`, `Anthropic Messages 处理错误`,
        // a media endpoint's, an Agent round's —: the request is over.
        bump(report, 'app.removedAccount.answerFailed')
        run.handler--
    } else {
        // An ERROR that fits neither is not the echo: the line is another's, and reads as it always did.
        report.removedEcho = null
        return false
    }
    // With nothing due any more, the run takes no line: the next of the echo's shape is another's.
    run.at = time
    return true
}

function readWorkerLine(report, event, detail, at) {
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
        case 'request': {
            // The app's calls are POSTs to a route; anything else that reached the
            // worker is listed under "other". The line ends with how long the call took.
            if ((found = /^(\w+) (\S+) -> (\d{3}) (\d+)ms$/.exec(detail)) || (found = /^(\w+) (\S+) -> (\d{3}) /.exec(detail))) {
                const route = found[1] === 'POST' && /^\/\w+$/.test(found[2]) ? found[2].slice(1) : 'other'
                bump(report, `workerHttp.${route}.${found[3]}`)
                // An egress call the worker gave up on, by how long it waited (Qwen2API-jk9, Qwen2API-2ba): the
                // line does not say which call it was, the time it took does — against the limits the app gives
                // its calls (GENERATION_LIMIT_MS, COMPLETIONS_LIMIT_MS). A line without one is counted as it is.
                if (route === 'egress' && found[3] === '504' && found[4]) {
                    const waited = Number(found[4])
                    bump(report, `workerHttp.egress.504.${
                        waited >= COMPLETIONS_LIMIT_MS ? 'noHead' : waited >= GENERATION_LIMIT_MS ? 'generation' : 'noAnswer'}`)
                }
            } else bump(report, 'unparsed.worker')
            return
        }
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
                // The answer the wait ran out under may be a picture or a video the app says failed: the
                // worker's time of it is kept for the app's lines (judgeMediaFailures).
                if (found[1] !== 'ended') report.cutWaits.push(Date.parse(at))
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
        case 'forget': {
            // What became of a removed account's session, page and browser profile (Qwen2API-2l0, Qwen2API-t8s):
            // the answer of /forget, by the profile's outcome; what came of a deletion put off to after a pause,
            // said when the pause is over; what the worker's start made of the marks that outlived it. A profile
            // that could not be removed is two lines — why, a code of the file system's, and the outcome —: the
            // first is counted by itself, the code goes into no name.
            if ((found = /^(?:session|no session), (?:page|no page), profile (deleted|left|deferred|kept|absent)(, a (?:login|renewal) still running)? \(\d+ sessions\)$/.exec(detail))) {
                bump(report, `forget.${found[1]}`)
                // A sign-in or a renewal of the account outlived /forget's patience: it may leave a session behind.
                if (found[2]) bump(report, 'forget.pending')
            } else if ((found = /^profile not removed (after the pause )?\(\w+\)$/.exec(detail))) {
                bump(report, found[1] ? 'forget.afterThePause.notRemoved' : 'forget.notRemoved')
            } else if ((found = /^profile (deleted|left) after the pause \(\d+ sessions\)$/.exec(detail))) {
                bump(report, `forget.afterThePause.${found[1]}`)
            } else if (detail === 'a mark that names no profile of its own was left alone') {
                bump(report, 'forget.mark.leftAlone')
            } else if (detail === 'a mark could not be read: its profile stays as it is') {
                bump(report, 'forget.mark.unreadable')
            } else bump(report, 'unparsed.worker')
            return
        }
        default:
            bump(report, 'worker.stopping')
    }
}

function readAppLine(report, level, message, at) {
    report.lines.app++
    // The logger puts its emoji in front of the message, and no message starts
    // with something that is not a letter, a digit or a quote.
    const first = /^\S+/.exec(message)?.[0]
    if (first && !/[\p{L}\p{N}"'`]/u.test(first)) message = message.slice(first.length).trimStart()
    let found
    // The echo of the requests the app ended because their account was removed meanwhile (Qwen2API-u50):
    // read before the line is sorted, for the echo is not read as what it looks like — not a refusal of
    // chats/new, not an answer that failed, not a picture that failed, not an error nobody knows.
    if (readRemovedEcho(report, level, message, at, message.startsWith(REMOVED_REQUEST) && message.endsWith(')'))) return
    if ((found = /^Qwen chat creation failed: category=([a-z0-9_]+)/.exec(message))) {
        bump(report, `app.chatsNewRefused.${found[1]}`)
    } else if (message.includes('chats/new через signin-worker не прошёл')) {
        bump(report, `app.workerRefused.chatsNew.${(/\(([a-z_]+)\)/.exec(message) || [null, 'unreachable'])[1]}`)
    } else if (message === '发送聊天请求失败' || message.startsWith('发送聊天请求失败: ')) {
        // Every attempt of a chat request failed (src/utils/request.js): its client got an error. Counted altogether,
        // and by what failed. The forms with a colon say it on the line; of the bare one it is the message, which
        // the logger prints on the line after it (saidChatRequestFailure).
        bump(report, 'app.chatRequestFailed')
        if (message.includes('completions через signin-worker не прошёл')) {
            const code = (/\(([a-z_]+)\)/.exec(message) || [null, 'unreachable'])[1]
            // The worker could not carry the completions call: counted as the refusal of the worker it always was...
            bump(report, `app.workerRefused.completions.${code}`)
            // ...and as the chat request that failed with it.
            bump(report, `app.chatRequestFailed.worker.${code}`)
        } else if (message === '发送聊天请求失败: 账户额度已耗尽') {
            bump(report, 'app.chatRequestFailed.quota')
        } else if (message === '发送聊天请求失败') {
            report.chatRequestMessage = true
        } else {
            bump(report, 'app.chatRequestFailed.other')
        }
    } else if (message.includes('completions через signin-worker не прошёл')) {
        bump(report, `app.workerRefused.completions.${(/\(([a-z_]+)\)/.exec(message) || [null, 'unreachable'])[1]}`)
    } else if (message.includes('v2 会话已续期')) {
        bump(report, 'app.recovered')
    } else if (message.includes('v2 会话续期失败')) {
        bump(report, `app.recoveryFailed.${(/\): ([A-Za-z_]+)/.exec(message) || [null, 'error'])[1]}`)
    } else if (message.includes('v2 会话失效')) {
        bump(report, 'app.sessionDropped')
    } else if (message.startsWith('v2 会话持久化失败 (')) {
        // A session was not saved to storage (src/utils/v2-session-persistence.js): it costs a sign-in after a
        // restart, not this request. The account on the line goes nowhere.
        bump(report, 'app.sessionNotSaved')
    } else if (message.includes('v2 полный вход отложен')) {
        bump(report, 'app.reloginDeferred')
    } else if (message.includes('v2 полный вход невозможен')) {
        bump(report, 'app.reloginImpossible')
    } else if (message.startsWith(REMOVED_REQUEST) && message.endsWith(')')) {
        // The app ended a request because its account was removed meanwhile (src/utils/browser-egress.js): what is
        // asked of a removed account, said once a request. Its own error lines follow, and are read as its echo
        // (readRemovedEcho): this line opens the run, or adds a request to the one that is open.
        bump(report, 'app.removedAccount')
    } else if (message === '聊天处理错误') {
        // An answer failed while the app was handling it (src/controllers/chat.js): one it had
        // begun to hand to its client ends in an error frame. The error is on the lines after.
        bump(report, 'app.chatFailed')
    } else if (message === '非流式聊天处理错误') {
        // The same of an answer without a stream: the client gets a 502.
        bump(report, 'app.wholeAnswerFailed')
    } else if (message === 'Anthropic Messages 处理错误') {
        // The same on the Anthropic route (src/controllers/anthropic.js), with a stream and without.
        bump(report, 'app.anthropicFailed')
    } else if (MEDIA_FAILED.includes(message)) {
        // A picture or a video failed while the app handled its request: one line or several of one request
        // (MEDIA_FAILED), each judged for itself. They are what a page reload that cut the generation under its
        // limit leaves (the client gets a 503) where the worker says a navigation's wait ran out right there;
        // elsewhere they are failures of their own. Which is which is judged when the feed is over
        // (judgeMediaFailures).
        report.mediaFailures.push(appTime(at))
    } else if ((found = /^非流式整体重试 \(原因: ([a-z_0-9]+)(?:, .*)?\)$/.exec(message))) {
        // Since Qwen2API-jk9 (2026-11-27): a request without a stream whose first attempt died before a byte
        // of its answer reached the client is made once more, whole (src/utils/whole-answer-retry.js). Counted
        // altogether, and by why: upstream_broke, network_error, upstream_5xx, chats_new_timeout. What the
        // reason carries after its comma — the relay's code, the status — stays in the line.
        bump(report, 'app.wholeAnswerRetry')
        bump(report, `app.wholeAnswerRetry.${found[1]}`)
    } else if (/^非流式整体重试成功 \(原因: /.test(message)) {
        // ...and the retried answer reached the client.
        bump(report, 'app.wholeAnswerRetry.delivered')
    } else if (message.startsWith('聊天请求传输错误')) {
        // A call the app makes once more, nothing having reached its client yet (src/utils/request.js).
        bump(report, 'app.retried')
    } else if (message.includes('服务器启动成功') || message.includes('v2 会话恢复完成')) {
        bump(report, 'app.started')
    } else if (/^Model "[^"]*" has no MODEL_MAP entry, using "[^"]*" \(/.test(message)) {
        // A client asked for a model the app does not know, and is answered with the map's stand-in for it
        // (src/utils/model-map.js). One counter for all of them: the names are the clients' to send, and
        // a listing does not grow by them.
        bump(report, 'app.modelMapFallback')
    } else if (message.startsWith('signin-worker 已忘掉账户 ') && message.endsWith('，浏览器配置稍后删除）')) {
        // The app had the worker forget a removed account, and its browser profile goes after a pause
        // (Qwen2API-t8s; src/utils/account.js): the worker's own `forget` lines say what came of it.
        bump(report, 'app.forgetProfileDeferred')
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
        // The line after a bare `发送聊天请求失败` is its message when it is a line of neither side's log:
        // read before the line is sorted, for that is what tells the two apart. It stays an "other" line;
        // a line of a log, or none at all, means the message did not come.
        if (report.chatRequestMessage) {
            const logLine = WORKER_LINE.test(line) || APP_LINE.test(line) || FLAG_LINE.test(line)
            saidChatRequestFailure(report, logLine ? null : line)
        }
        report.chatRequestMessage = false
        if ((found = WORKER_LINE.exec(line))) {
            note(report, found[1])
            readWorkerLine(report, found[2], found[3], found[1])
        } else if ((found = APP_LINE.exec(line))) {
            // The app's clock is local time without a zone: it does not feed the window.
            readAppLine(report, found[2], found[4], found[1])
        } else if ((found = FLAG_LINE.exec(line))) {
            report.flags = { ...(report.flags || {}), [found[1]]: found[3] }
        } else if (line.trim()) {
            // Neither a line of the app's nor of the worker's: the echo of a removed account's request is
            // not touched by it (readRemovedEcho) — in one feed of both, a line of the app's stdout may
            // land between its lines on stderr.
            report.lines.other++
        }
    }
    // When the feed is over: which of the app's picture and video failures a navigation's wait that ran out
    // explains — by time, whichever log came first —, and the kind of a chat request whose message did not come.
    judgeMediaFailures(report)
    if (report.chatRequestMessage) saidChatRequestFailure(report, null)
    // The report may be fed again: nothing of this feed is waited for any more.
    report.chatRequestMessage = false
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
    // On the Anthropic route there is one handler for an answer with a stream and without: said as its own count.
    const failedAnswers = count('app.chatFailed') + count('app.wholeAnswerFailed') + count('app.anthropicFailed')
    if (failedAnswers) {
        why.push(`${failedAnswers} answer(s) failed while the application handled them: ` +
            `${count('app.chatFailed')} with a stream, ${count('app.wholeAnswerFailed')} without` +
            (count('app.anthropicFailed') ? `, ${count('app.anthropicFailed')} on the Anthropic route` : ''))
    }
    // The same of a picture or a video (src/controllers/chat.image.video.js) where no navigation's wait that ran
    // out lies by it (judgeMediaFailures): a failure of its own, not the cut a reload under its limit makes.
    if (count('app.mediaFailed')) {
        why.push(`${count('app.mediaFailed')} picture/video error line(s) in the app that no reload's wait for the page's streams explains: the reason is on the lines after`)
    }
    // A chat request that failed on every attempt (src/utils/request.js): its client got an error. Said by what
    // failed, a request once. One the worker did not carry is said by "the worker could not serve" above, though
    // it is counted here as well (readAppLine).
    const failedRequests = [...report.counts]
        .filter(([name]) => name.startsWith(CHAT_REQUEST_FAILED) && !name.startsWith(`${CHAT_REQUEST_FAILED}worker.`))
        .sort(([a], [b]) => a.localeCompare(b))
    if (failedRequests.length) {
        const said = ([name, hits]) => {
            const kind = name.slice(CHAT_REQUEST_FAILED.length)
            if (/^\d{3}$/.test(kind)) return `${hits} with status ${kind}`
            return kind === 'quota' ? `${hits} for a spent quota` : `${hits} otherwise`
        }
        why.push(`${failedRequests.reduce((sum, [, hits]) => sum + hits, 0)} chat request(s) failed: ${failedRequests.map(said).join(', ')}`)
    }
    // The worker's own answer to an egress call that was not a success. The app's
    // line says which code when the app's log is in the feed; the worker's alone still says it happened.
    const notServed = [...report.counts].filter(([name]) => /^workerHttp\.egress\.([3-5]\d\d)$/.test(name))
    if (notServed.length) {
        const statuses = notServed.map(([name]) => name.slice('workerHttp.egress.'.length)).sort().join(' and ')
        // Of 504s, by how long the call waited against the limits the app gives its calls (readWorkerLine).
        // Said of the kinds there are.
        const kinds = []
        if (count('workerHttp.egress.504.noAnswer')) kinds.push(`${count('workerHttp.egress.504.noAnswer')} in under five minutes (a call that did not return from the page in time — chats/new's limit is 30 s; Qwen2API-jk9)`)
        if (count('workerHttp.egress.504.generation')) kinds.push(`${count('workerHttp.egress.504.generation')} after five minutes or more (a picture or video generation that did not finish in its limit of five)`)
        if (count('workerHttp.egress.504.noHead')) kinds.push(`${count('workerHttp.egress.504.noHead')} after ten minutes or more (completions gave no head — Qwen2API-2ba)`)
        why.push(`the worker answered ${notServed.reduce((sum, [, hits]) => sum + hits, 0)} egress call(s) with HTTP ${statuses}${kinds.length ? `: ${kinds.join(', ')}` : ''}`)
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
    // What became of a removed account's browser profile (the worker's `forget` lines, readWorkerLine): one
    // that could not be removed stays on the disk, and a mark that could not be read leaves its profile for good.
    // Each count is said by its name, as the listing under "accounts forgotten" shows it.
    const leftNow = count('forget.left')
    const leftLater = count('forget.afterThePause.left')
    const notRemoved = count('forget.notRemoved') + count('forget.afterThePause.notRemoved')
    if (leftNow + leftLater + notRemoved) {
        const byName = []
        if (leftNow) byName.push(`left ${leftNow}`)
        if (count('forget.notRemoved')) byName.push(`not removed ${count('forget.notRemoved')}`)
        if (leftLater) byName.push(`left after the pause ${leftLater}`)
        if (count('forget.afterThePause.notRemoved')) byName.push(`not removed after the pause ${count('forget.afterThePause.notRemoved')}`)
        why.push(`${leftNow + leftLater || notRemoved} forgotten account(s): the browser profile could not be removed (${byName.join(', ')})`)
    }
    if (count('forget.mark.unreadable')) why.push(`${count('forget.mark.unreadable')} mark(s) of a deletion put off could not be read`)
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
    section('accounts forgotten: what became of their browser profiles', 'forget.')
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
    // says nothing about what qwen.ai did; nor does the app's word of a profile that
    // goes after a pause.
    else {
        const judged = total(report, 'egress.') + total(report, 'stream.') + total(report, 'workerHttp.egress.') +
            total(report, 'app.') - count('app.started') - count('app.forgetProfileDeferred')
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
