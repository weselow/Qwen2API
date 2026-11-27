const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const watch = require('../tools/egress-log-watch')
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

// A worker clock: ISO, minutes apart.
const at = minute => `2026-11-24T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${
    String(minute % 60).padStart(2, '0')}:00.000Z`
// The app's clock: local time, no zone (src/utils/logger.js#formatTimestamp).
const appAt = minute => at(minute).slice(0, 19).replace('T', ' ')
const COMPLETIONS = '/api/v2/chat/completions'

// One generation as the worker logs it: the page opens on the first, then
// chats/new, then the stream of the answer — which ends as `ending` says.
function generation(minute, { first = false, ending = 'end' } = {}) {
    return [
        ...(first ? [`${at(minute)} resident-open ok (1/16 pages, front-end 0.3.50)`] : []),
        `${at(minute)} egress /api/v2/chats/new -> 200 (1/16 pages)`,
        `${at(minute)} request POST /egress -> 200 850ms`,
        `${at(minute)} egress-stream ${COMPLETIONS} -> 200 (900 ms, 1/16 pages)`,
        `${at(minute)} egress-stream ${COMPLETIONS} ${ending} (5200 ms)`,
        `${at(minute)} request POST /egress -> 200 5300ms`
    ]
}
const appLine = (minute, level, module, message) =>
    `${appAt(minute)} [${level}] [${module}] ${message}`

// The app runs on Bun, which prints an object with double quotes and a trailing comma.
const STARTUP = [
    appLine(0, 'INFO', 'SERVER', '🚀 服务器启动成功'),
    '{',
    '  address: "0.0.0.0",',
    '  port: 3000,',
    '  chatCreationTransport: "browser",',
    '  completionsTransport: "browser",',
    '}'
]

test('a healthy hour through the pages reads OK', () => {
    const lines = [
        `${at(0)} signin-worker listening on :3100 (browser: headless shell)`,
        ...STARTUP,
        ...generation(1, { first: true }),
        ...generation(20),
        ...generation(59, { ending: 'cancelled' }),
        // The logger's success() prints as INFO.
    appLine(59, 'INFO', 'V2SESSION', '✅ v2 会话已续期 (a@example.invalid, 触发原因: upstream_session_unauthorized)')
    ]
    const { verdict, why, text } = watch.render(watch.summarize(lines))
    assert.equal(verdict, 'OK', why.join('\n'))
    const counts = watch.summarize(lines).counts
    assert.equal(counts.get('egress.chatsNew.200'), 3)
    assert.equal(counts.get('stream.head.200'), 3)
    assert.equal(counts.get('stream.ended'), 2)
    assert.equal(counts.get('stream.cancelled'), 1)
    assert.equal(counts.get('pages.opened'), 1)
    assert.equal(counts.get('app.recovered'), 1)
    // What the report says about the hour.
    assert.match(text, /window: 2026-11-24T10:00:00\.000Z \.\. 2026-11-24T10:59:00\.000Z \(59\.0 min\)/)
    assert.match(text, /flags at the app's start: chats\/new=browser, completions=browser; worker browser: headless shell/)
    assert.match(text, /resident pages at most at once: 1 of 16/)
    assert.match(text, /chatsNew\.200 {2}3/)
})

test('the colors the logger writes on a console do not hide a line', () => {
    const colored = '\u001b[2m2026-11-24 10:05:00\u001b[0m \u001b[31m[ERROR]\u001b[0m \u001b[1m[CHAT]\u001b[0m ❌ ' +
        'Qwen chat creation failed: category=upstream_waf_challenge, status=403'
    const plain = watch.plain(colored)
    assert.equal(plain, '2026-11-24 10:05:00 [ERROR] [CHAT] ❌ Qwen chat creation failed: category=upstream_waf_challenge, status=403')
    assert.equal(watch.summarize([colored]).counts.get('app.chatsNewRefused.upstream_waf_challenge'), 1)
    assert.equal(watch.summarize([plain]).counts.get('app.chatsNewRefused.upstream_waf_challenge'), 1)
})

test('a refusal of chats/new by qwen.ai is the first thing said', () => {
    // As the logger prints it: its own emoji in front of the message.
    for (const code of ['upstream_session_unauthorized', 'upstream_waf_challenge']) {
        const { verdict, why } = watch.render(watch.summarize([
            ...STARTUP,
            appLine(3, 'ERROR', 'CHAT', `❌ Qwen chat creation failed: category=${code}, status=401`)
        ]))
        assert.equal(verdict, 'LOOK')
        // Said once: the named refusal is not repeated among "the others".
        assert.deepEqual(why, [`qwen.ai refused chats/new as ${code}: 1`])
    }
    // Another category (a quota, an answer of a shape nobody knows) is listed, and said.
    const other = watch.render(watch.summarize([
        appLine(3, 'ERROR', 'CHAT', 'Qwen chat creation failed: category=upstream_invalid_response, status=502')
    ]))
    assert.equal(other.verdict, 'LOOK')
    assert.match(other.text, /chatsNewRefused\.upstream_invalid_response {2}1/)
    // Said once: the two named refusals are not repeated among "the others".
    assert.deepEqual(other.why, ['chats/new failed otherwise: upstream_invalid_response 1'])
    // A category with a digit in it is read whole.
    assert.deepEqual(watch.complaints(watch.summarize([
        appLine(3, 'ERROR', 'CHAT', 'Qwen chat creation failed: category=v2_session_required, status=409')
    ])), ['chats/new failed otherwise: v2_session_required 1'])
})

test('a worker that could not serve a call is said, with its code', () => {
    const refused = code => appLine(4, 'ERROR', 'CHAT',
        `CHAT_CREATION_TRANSPORT=browser: chats/new через signin-worker не прошёл${code ? ` (${code})` : ''}: the worker did not answer`)
    for (const [code, expected] of [['page_closed', 'page_closed'], ['resident_capacity', 'resident_capacity'], ['', 'unreachable']]) {
        const counts = watch.summarize([refused(code)]).counts
        assert.equal(counts.get(`app.workerRefused.chatsNew.${expected}`), 1)
    }
    const { verdict, why } = watch.render(watch.summarize([refused('egress_timeout')]))
    assert.equal(verdict, 'LOOK')
    assert.match(why[0], /the worker could not serve 1 call/)
    // The completions leg has a line of its own.
    assert.equal(watch.summarize([appLine(4, 'ERROR', 'REQUEST',
        '发送聊天请求失败: completions через signin-worker не прошёл (relay_malformed): no head event')]).counts
        .get('app.workerRefused.completions.relay_malformed'), 1)
})

test('a stream that ends in an error is said; one the client left alone is only counted', () => {
    const ended = how => watch.render(watch.summarize(generation(5, { ending: how })))
    assert.equal(ended('cancelled').verdict, 'OK')
    for (const code of ['egress_timeout', 'page_closed', 'browser_error', 'egress_failed', 'egress_too_large']) {
        const { verdict, why } = ended(code)
        assert.equal(verdict, 'LOOK', code)
        assert.deepEqual(why, ['1 stream(s) ended with an error'])
    }
})

test('a 401 head of a stream is counted; any other refusal is said', () => {
    const head = status => watch.render(watch.summarize([
        `${at(5)} egress-stream ${COMPLETIONS} -> ${status} (900 ms, 1/16 pages)`,
        `${at(5)} egress-stream ${COMPLETIONS} end (5200 ms)`
    ]))
    assert.equal(head(200).verdict, 'OK')
    for (const status of [403, 429, 500, 502, 503]) {
        assert.deepEqual(head(status).why, [`stream.head.${status}: 1`])
    }
    // A whole answer qwen.ai did not give as 200 is said as well.
    assert.deepEqual(watch.render(watch.summarize([
        `${at(5)} egress /api/v2/chats/new -> 405 (1/16 pages)`
    ])).why, ['egress.chatsNew.405: 1'])
})

test('a stream refused as 401 is the app\'s to recover from; refused more often than accepted is said', () => {
    const stream = (minute, status, how) => [
        `${at(minute)} egress-stream ${COMPLETIONS} -> ${status} (900 ms, 1/16 pages)`,
        `${at(minute)} egress-stream ${COMPLETIONS} ${how} (5200 ms)`
    ]
    // Refused once, the page reloaded, the retry accepted: what recovery is for.
    // A stream the app closed to retry is "cancelled" in the worker's log.
    const recovered = watch.render(watch.summarize([
        ...stream(5, 401, 'cancelled'),
        `${at(5)} renew ok (forced) (1 sessions)`,
        ...stream(5, 200, 'end')
    ]))
    assert.equal(recovered.verdict, 'OK', recovered.why.join('\n'))
    assert.equal(watch.summarize([...stream(5, 401, 'end')]).counts.get('stream.head.401'), 1)

    // The shape of 23.11: every call refused, the page reloaded for each, never accepted.
    const refused = watch.render(watch.summarize(Array.from({ length: 20 }, (_, atMinute) => [
        `${at(atMinute / 2)} egress /api/v2/chats/new -> 200 (1/16 pages)`,
        ...stream(atMinute / 2, 401, 'cancelled'),
        `${at(atMinute / 2)} renew ok (forced) (1 sessions)`
    ]).flat()))
    assert.equal(refused.verdict, 'LOOK')
    assert.deepEqual(refused.why, [
        'streams refused as 401 more often than accepted: 20 refused, 0 accepted',
        '20 forced reload(s), and not one stream finished'
    ])
    // One refusal against two accepted answers is not a pattern.
    const sparse = watch.render(watch.summarize([
        ...stream(5, 401, 'cancelled'),
        ...stream(20, 200, 'end'),
        ...stream(40, 200, 'end')
    ]))
    assert.deepEqual(sparse.why, [])
})

test('a worker that cannot open a page is something to look at, not nothing to judge', () => {
    // The feed if the chrome mode fails to launch after a flip: no call ever leaves.
    const dead = watch.render(watch.summarize([
        `${at(1)} resident-close open_failed (0 pages)`,
        `${at(1)} request POST /egress -> 500 12ms`,
        `${at(2)} resident-close open_failed (0 pages)`,
        `${at(2)} request POST /egress -> 500 12ms`
    ]))
    assert.equal(dead.verdict, 'LOOK')
    assert.deepEqual(dead.why, ['the worker answered 2 egress call(s) with HTTP 500', '2 resident page(s) died (not evicted or shut down)'])
    assert.match(dead.text, /egress\.500 {2}2/)
})

test('sign-ins and forced reloads are held to one a minute and one in half a minute', () => {
    const signIns = minutes => watch.complaints(watch.summarize(minutes.flatMap(minute => [
        `${at(minute)} session queued (1200ms)`,
        `${at(minute)} session acquired (1 sessions)`,
        `${at(minute)} request POST /session -> 200 20000ms`
    ])))
    // Three sign-ins in one minute is a batch; over three hours it is an account coming and going.
    assert.deepEqual(signIns([1, 1, 1]).map(line => line.replace(/: .*$/, '')), ['3 full sign-ins in 1.0 min'])
    assert.deepEqual(signIns([1, 61, 121]), [])

    const reloads = minutes => watch.complaints(watch.summarize(minutes.map(minute => `${at(minute)} renew ok (forced) (1 sessions)`)))
    assert.match(reloads([1, 1, 1])[0], /3 forced reloads in 1\.0 min: more than one in 30 s/)
    assert.deepEqual(reloads([1, 2, 3, 4, 5]), [])
    // An ordinary live reload is nobody's complaint, and is still counted.
    assert.deepEqual(watch.complaints(watch.summarize([`${at(1)} renew ok (1 sessions)`])), [])
})

test('a page that died is said; one evicted or shut down on purpose is not', () => {
    const closed = reason => watch.render(watch.summarize([
        `${at(5)} resident-close ${reason} (0 pages)`
    ]))
    for (const reason of ['unresponsive', 'page_crashed', 'context_closed', 'keepalive_failed', 'open_failed', 'operation_failed']) {
        assert.deepEqual(closed(reason).why, ['1 resident page(s) died (not evicted or shut down)'], reason)
    }
    for (const reason of ['evicted', 'shutdown', 'proxy_changed', 'unready', 'open_aborted']) {
        assert.deepEqual(closed(reason).why, [], reason)
    }
})

test('a refused session that nothing replaced is said', () => {
    const failed = watch.render(watch.summarize([
        `${at(5)} silent-renew failed (session_expired)`,
        appLine(5, 'ERROR', 'V2SESSION', 'v2 会话续期失败 (a@example.invalid, 触发原因: upstream_session_unauthorized): signin_busy (signin_paced)'),
        appLine(5, 'WARN', 'V2SESSION', 'v2 полный вход невозможен (a@example.invalid): у аккаунта нет пароля')
    ]))
    assert.equal(failed.verdict, 'LOOK')
    assert.match(failed.why[0], /a refused session was not replaced: recovery failed 1, silent renewal failed 1/)
    const counts = watch.summarize([
        `${at(5)} silent-renew failed (session_expired)`,
        appLine(5, 'ERROR', 'V2SESSION', 'v2 会话续期失败 (a@example.invalid, 触发原因: 401): signin_busy (signin_paced)'),
        appLine(5, 'WARN', 'V2SESSION', 'v2 полный вход отложен (a@example.invalid): чаще одного раза в 60000 мс входы не выполняются'),
        appLine(5, 'WARN', 'V2SESSION', 'v2 полный вход невозможен (b@example.invalid): у аккаунта нет пароля'),
        appLine(6, 'WARN', 'V2SESSION', 'v2 会话失效 (a@example.invalid, 原因: 401)——触发 signin-worker 续期')
    ]).counts
    assert.equal(counts.get('silentRenew.failed.session_expired'), 1)
    assert.equal(counts.get('app.recoveryFailed.signin_busy'), 1)
    assert.equal(counts.get('app.reloginDeferred'), 1)
    assert.equal(counts.get('app.reloginImpossible'), 1)
    assert.equal(counts.get('app.sessionDropped'), 1)
})

test('an error this tool does not know is listed, without the account in it', () => {
    const { verdict, text } = watch.render(watch.summarize([
        appLine(7, 'ERROR', 'REQUEST', 'something new went wrong for a@example.invalid'),
        appLine(7, 'WARN', 'ACCOUNT', 'a warning nobody classified'),
        appLine(7, 'INFO', 'REQUEST', 'an info line is not something to look at')
    ]))
    assert.equal(verdict, 'LOOK')
    assert.match(text, /unclassified\.ERROR {2}1/)
    assert.match(text, /unclassified\.WARN {2}1/)
    assert.match(text, /1x {2}something new went wrong for <account>/)
    assert.match(text, /1x {2}a warning nobody classified/)
    assert.doesNotMatch(text, /a@example\.invalid/)
})

test('the worker\'s own HTTP answers are counted, and not held against it', () => {
    const lines = [
        `${at(5)} request POST /renew -> 422 3ms`,
        `${at(5)} request POST /session -> 429 1ms`,
        `${at(5)} request POST /egress -> 503 2ms`,
        `${at(5)} request POST /egress -> 502 1500ms`,
        appLine(5, 'ERROR', 'CHAT', 'CHAT_CREATION_TRANSPORT=browser: chats/new через signin-worker не прошёл (resident_capacity): Every resident page is busy; none can be evicted.')
    ]
    const counts = watch.summarize(lines).counts
    assert.equal(counts.get('workerHttp.renew.422'), 1)
    assert.equal(counts.get('workerHttp.session.429'), 1)
    assert.equal(counts.get('workerHttp.egress.503'), 1)
    assert.equal(counts.get('workerHttp.egress.502'), 1)
    // The app's line names the code; the status alone is left to it, except for an egress
    // call the worker did not put through, which is said even from the worker's log alone.
    assert.deepEqual(watch.complaints(watch.summarize(lines)), [
        'the worker could not serve 1 call(s)',
        'the worker answered 2 egress call(s) with HTTP 502 and 503'
    ])
    assert.deepEqual(watch.complaints(watch.summarize(lines.slice(0, 2))), [])
})

test('the flags are read from the start-up record as Bun prints it, and as Node does', () => {
    const bun = watch.summarize(STARTUP)
    assert.deepEqual(bun.flags, { chatCreationTransport: 'browser', completionsTransport: 'browser' })
    assert.deepEqual(bun.lines, { worker: 0, app: 1, other: 4 })
    const node = watch.summarize([
        appLine(0, 'INFO', 'SERVER', '🚀 服务器启动成功'),
        '{',
        "  port: 3000,",
        "  chatCreationTransport: 'direct',",
        "  completionsTransport: 'auto'",
        '}'
    ])
    assert.deepEqual(node.flags, { chatCreationTransport: 'direct', completionsTransport: 'auto' })
})

test('a request the app never makes is listed, not taken for a shape this tool does not know', () => {
    const { verdict, text } = watch.render(watch.summarize([
        ...generation(5),
        `${at(5)} request GET / -> 404 1ms`,
        `${at(5)} request POST / -> 404 1ms`
    ]))
    assert.equal(verdict, 'OK')
    assert.match(text, /other\.404 {2}2/)
})

test('a line of a shape this tool does not know is said, not skipped', () => {
    const { verdict, why } = watch.render(watch.summarize([
        ...generation(5),
        `${at(5)} egress something else entirely`
    ]))
    assert.equal(verdict, 'LOOK')
    assert.deepEqual(why, ['1 line(s) of a shape this tool does not know'])
    // Noise that is not a log line (an object the logger printed, a blank) is not that.
    assert.deepEqual(watch.complaints(watch.summarize(STARTUP)), [])
    assert.equal(watch.summarize(['', '   ', '{', '}']).lines.other, 2)
})

test('an hour with nothing from the egress in it has nothing to judge', () => {
    for (const lines of [[], ['hello'], STARTUP]) {
        assert.equal(watch.render(watch.summarize(lines)).verdict, 'NOTHING TO JUDGE')
    }
    // With the flags off the direct path still reports its refusals: that is something.
    assert.equal(watch.render(watch.summarize([
        ...STARTUP,
        appLine(3, 'ERROR', 'CHAT', 'Qwen chat creation failed: category=upstream_session_unauthorized, status=401')
    ])).verdict, 'LOOK')
})

test('as a command it reads stdin and leaves its verdict as the exit code', () => {
    const run = input => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'egress-log-watch.js')], {
        input, encoding: 'utf8'
    })
    const healthy = run([...STARTUP, ...generation(1, { first: true })].join('\r\n'))
    assert.equal(healthy.status, 0, healthy.stderr)
    assert.match(healthy.stdout, /verdict: OK/)
    const refused = run([appLine(3, 'ERROR', 'CHAT', 'Qwen chat creation failed: category=upstream_waf_challenge, status=403')].join('\n'))
    assert.equal(refused.status, 1)
    assert.match(refused.stdout, /verdict: LOOK\n {2}- qwen\.ai refused chats\/new as upstream_waf_challenge: 1/)
    const empty = run('')
    assert.equal(empty.status, 2)
    assert.match(empty.stdout, /verdict: NOTHING TO JUDGE/)
})

test('a WAF challenge page under status 200 is counted as a challenge, not as a 200, and said', () => {
    // What the worker prints of one (Qwen2API-3ue.6): the status, and the note.
    const lines = [
        `${at(0)} resident-open ok (1/16 pages, front-end 0.3.50)`,
        `${at(1)} egress /api/v2/chats/new -> 200 (1/16 pages) — WAF challenge page`,
        `${at(2)} egress /api/v2/chats/new -> 200 (1/16 pages) — WAF challenge page, kept from the call by the page`,
        `${at(3)} egress-stream ${COMPLETIONS} -> 200 (5 ms, 1/16 pages)`,
        `${at(3)} egress-stream ${COMPLETIONS} end (1200 ms) — WAF challenge page`,
        `${at(4)} egress-stream ${COMPLETIONS} -> 200 (5 ms, 1/16 pages)`,
        `${at(4)} egress-stream ${COMPLETIONS} end (1010 ms) — WAF challenge page, kept from the call by the page`,
        ...generation(5)
    ]
    const report = watch.summarize(lines)
    assert.equal(report.counts.get('egress.chatsNew.challenge'), 1)
    assert.equal(report.counts.get('egress.chatsNew.challenge.kept'), 1)
    assert.equal(report.counts.get('egress.chatsNew.200'), 1)
    assert.equal(report.counts.get('stream.challenge'), 1)
    assert.equal(report.counts.get('stream.challenge.kept'), 1)
    assert.equal(report.counts.get('stream.ended'), 1)
    assert.equal(report.unparsedSize, undefined)
    assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
    assert.equal(report.pages.frontEnd, undefined)
    assert.equal(report.counts.get('pages.frontEnd.0.3.50'), 1)
    const { verdict, why, text } = watch.render(report)
    assert.equal(verdict, 'LOOK')
    assert.deepEqual(why, ['qwen.ai answered 4 call(s) with a WAF challenge page under status 200; ' +
        "the page's scripts kept 2 of them from the call (the worker read those off its network)"])
    assert.match(text, /challenge\.kept {2}1/)
})

test('a challenged stream is no accepted one: refusals are counted against the answers qwen.ai gave', () => {
    const lines = [
        // One answer that was a challenge page: a 200 to the eye.
        `${at(0)} egress-stream ${COMPLETIONS} -> 200 (5 ms, 1/16 pages)`,
        `${at(0)} egress-stream ${COMPLETIONS} end (1200 ms) — WAF challenge page`,
        // And two refusals of the session.
        `${at(1)} egress-stream ${COMPLETIONS} -> 401 (5 ms, 1/16 pages)`,
        `${at(1)} egress-stream ${COMPLETIONS} end (20 ms)`,
        `${at(2)} egress-stream ${COMPLETIONS} -> 401 (5 ms, 1/16 pages)`,
        `${at(2)} egress-stream ${COMPLETIONS} end (20 ms)`
    ]
    const { why } = watch.render(watch.summarize(lines))
    // One answer was a challenge page, which is no accepted answer: two refusals against none.
    assert.ok(why.includes('streams refused as 401 more often than accepted: 2 refused, 0 accepted'), why.join('\n'))
})

test('a stream a script of the page cut is said as a stream that failed; it is not the app going away', () => {
    const { verdict, why, text } = watch.render(watch.summarize([
        `${at(0)} resident-open ok (1/16 pages, front-end 0.3.50)`,
        `${at(1)} egress-stream ${COMPLETIONS} -> 200 (5 ms, 1/16 pages)`,
        `${at(1)} egress-stream ${COMPLETIONS} page_fault (120 ms)`,
        appLine(1, 'ERROR', 'REQUEST', '发送聊天请求失败: completions через signin-worker не прошёл (page_fault): signin-worker egress: page_fault'),
        ...generation(20)
    ]))
    assert.equal(verdict, 'LOOK')
    assert.deepEqual(why, ['the worker could not serve 1 call(s)', '1 stream(s) ended with an error'])
    assert.match(text, /failed\.page_fault {2}1/)
    assert.match(text, /completions\.page_fault {2}1/)
    assert.equal(watch.summarize([`${at(3)} egress-stream ${COMPLETIONS} page_fault (9 ms)`]).counts.get('stream.cancelled'), undefined)
})

test('a page that showed no front-end version is said: its calls carry no version header', () => {
    const { verdict, why } = watch.render(watch.summarize([
        `${at(0)} resident-open ok (1/16 pages, front-end unknown)`,
        ...generation(1)
    ]))
    assert.equal(verdict, 'LOOK')
    assert.deepEqual(why, ['1 resident page(s) showed no front-end version: their calls carry no version header'])
    // A worker from before the front end was logged (no such word on the line) is not a shape this tool knows.
    assert.equal(watch.summarize([`${at(0)} resident-open ok (1/16 pages)`]).counts.get('unparsed.worker'), 1)
})

test('the shapes it reads are the shapes the code prints', () => {
    const worker = read('signin-worker/server.js')
    const residents = read('signin-worker/lib/resident-pages.js')
    const egress = read('src/utils/browser-egress.js')
    const request = read('src/utils/request.js')
    const persistence = read('src/utils/v2-session-persistence.js')
    // Reword one of these and the line stops being counted: keep the tool with it.
    const printed = [
        [worker, "log('egress', `${new URL(request.url).pathname} -> ${result.status} ("],
        [worker, '(CHALLENGE_NOTE[result.challenge] || \'\')'],
        [worker, "const CHALLENGE_NOTE = { page: ' — WAF challenge page', network: ' — WAF challenge page, kept from the call by the page' }"],
        // Since Qwen2API-0c6: what the line says of an answer beyond its status.
        [worker, ' + answerNote(result))'],
        [read('signin-worker/lib/egress-fetch.js'), 'notes.push(`code ${shown}`)'],
        [read('signin-worker/lib/egress-fetch.js'), "notes.push('refused, no code')"],
        [read('signin-worker/lib/egress-fetch.js'), "notes.push(`headers: ${shown.length ? shown.join(', ') : 'none'}`)"],
        [read('signin-worker/lib/egress-fetch.js'), "return notes.length ? ` — ${notes.join('; ')}` : ''"],
        // Since Qwen2API-xun, Qwen2API-nch and Qwen2API-ops: the page's token, a navigation's wait, a load's turn.
        [residents, "log('token-refresh', `ok (${took} ms, "],
        [residents, "log('token-refresh', `failed ("],
        [residents, "(waited ${waited} ms for the page's streams)"],
        [residents, "`${left ? `${left} still running` : 'ended'} ("],
        [read('signin-worker/lib/page-load-queue.js'), "log('page-load', `waited ("],
        [read('signin-worker/lib/page-load-queue.js'), "ms${entry.packed ? ', a long line packed' : ''})`)"],
        // A renewal answered by a session that turned live while it waited.
        [worker, "log('renew', `${outcome.reloaded ? `ok${forced ? ' (forced)' : ''}` : 'no reload'} (${sessions.size} sessions)`)"],
        // And three of the app's own lines.
        [read('src/controllers/chat.js'), "logger.error('聊天处理错误', 'CHAT', '', error)"],
        [read('src/controllers/chat.js'), "logger.error('非流式聊天处理错误'"],
        [request, '`聊天请求传输错误 (尝试 ${attempt}/${totalAttempts}, code='],
        [worker, '`${pathname} -> ${event.status} (${Date.now() - started} ms, `'],
        [worker, '`${pathname} cancelled (${Date.now() - started} ms)`'],
        [worker, '`${pathname} end (${Date.now() - started} ms)'],
        [worker, '`${pathname} ${code} (${Date.now() - started} ms)`'],
        [worker, "log('request', `${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms`)"],
        [residents, "log('resident-open', `ok (${pages.size}/${maxPages} pages, front-end "],
        [residents, "log('resident-close', `${reason} (${pages.size} pages)`)"],
        [worker, "log('session', `acquired (${sessions.size} sessions)`)"],
        [worker, 'log(\'session\', \'cached\')'],
        [worker, "log('session', `queued (${Math.ceil(slot.waitMs)}ms)`)"],
        [worker, "log('silent-renew', `ok (${sessions.size} sessions)`)"],
        [worker, "log('silent-renew', `failed (${error.code || 'error'})`)"],
        [worker, '(browser: ${headless ? `headless ${headlessMode}` : \'headed\'})'],
        [egress, 'chats/new через signin-worker не прошёл'],
        [request, '发送聊天请求失败: completions через signin-worker не прошёл'],
        [request, 'Qwen chat creation failed: category=${failure.code}, status=${failure.status}'],
        [persistence, 'v2 会话已续期 (${email}, 触发原因: ${reason})'],
        [persistence, 'v2 会话续期失败 (${email}, 触发原因: ${reason}): ${error.code || \'error\'}'],
        [persistence, 'v2 会话失效 (${email}, 原因: ${reason})'],
        [persistence, 'v2 полный вход отложен (${email})'],
        [persistence, 'v2 полный вход невозможен (${email})'],
        [read('src/server.js'), 'chatCreationTransport: config.chatCreationTransport'],
        [read('src/server.js'), 'completionsTransport: config.completionsTransport'],
        // Since Qwen2API-jk9 (2026-11-27): the two lines of a whole answer asked for once more.
        [read('src/utils/whole-answer-retry.js'), 'logger.warn(`非流式整体重试 (原因: ${reason})`, \'REQUEST\')'],
        [read('src/utils/whole-answer-retry.js'), 'logger.info(`非流式整体重试成功 (原因: ${reason})`, \'REQUEST\')']
    ]
    for (const [source, template] of printed) assert.ok(source.includes(template), `reworded: ${template}`)
})

// Since Qwen2API-jk9 (2026-11-27): a request without a stream whose first attempt died before a byte
// reached its client is made once more, whole (src/utils/whole-answer-retry.js). The app says so twice:
// when the retry begins, and when its answer is delivered.

// The log as the app writes it while a whole answer is asked for once more: as the logger prints it, emoji in front.
const retried = (minute, reason, delivered = true) => [
    appLine(minute, 'WARN', 'REQUEST', `⚠️ 非流式整体重试 (原因: ${reason})`),
    ...(delivered ? [appLine(minute, 'INFO', 'REQUEST', `📝 非流式整体重试成功 (原因: ${reason})`)] : [])
]

test('a whole answer asked for once more is counted — begun, by why, and delivered — and is not listed as unknown (Qwen2API-jk9)', () => {
    const lines = [
        ...STARTUP,
        ...generation(1),
        ...retried(2, 'upstream_broke, egress_failed'),
        ...retried(3, 'network_error, ECONNRESET'),
        ...retried(4, 'upstream_5xx, 502'),
        ...retried(5, 'chats_new_timeout'),
        ...retried(6, 'upstream_broke, page_closed'),
        // Begun, and not delivered: the client left while the retry was under way.
        ...retried(7, 'upstream_broke, egress_failed', false),
        ...generation(20)
    ]
    const report = watch.summarize(lines)
    assert.equal(report.counts.get('app.wholeAnswerRetry'), 6, 'every retry that began')
    assert.equal(report.counts.get('app.wholeAnswerRetry.delivered'), 5, 'every retry whose answer reached the client')
    // By why — what comes before the comma; the relay's code and the status stay in the line.
    assert.equal(report.counts.get('app.wholeAnswerRetry.upstream_broke'), 3)
    assert.equal(report.counts.get('app.wholeAnswerRetry.network_error'), 1)
    assert.equal(report.counts.get('app.wholeAnswerRetry.upstream_5xx'), 1)
    assert.equal(report.counts.get('app.wholeAnswerRetry.chats_new_timeout'), 1)
    assert.equal(report.counts.get('app.unclassified.WARN'), undefined, 'the WARN is not an unknown warning')
    assert.equal(report.unknown.size, 0)
    const { verdict, why, text } = watch.render(report)
    // A retry that delivered is a symptom, and the symptom is not complained of on its own: the break itself was
    // not in these lines, and nothing else is.
    assert.equal(verdict, 'OK', why.join('\n'))
    assert.match(text, /wholeAnswerRetry {2}6/)
    assert.match(text, /wholeAnswerRetry\.delivered {2}5/)
    assert.match(text, /wholeAnswerRetry\.upstream_broke {2}3/)
    assert.match(text, /wholeAnswerRetry\.chats_new_timeout {2}1/)
})

test('the why of a retry the counter reads are the reasons the retry is given, each spelled as the code spells it (Qwen2API-jk9)', () => {
    // Read off the module's own words, without loading it: it brings in the request path and the account manager.
    const helper = read('src/utils/whole-answer-retry.js')
    const named = [...helper.matchAll(/^const (?:BROKEN|NETWORK_ERROR|UPSTREAM_5XX|CHATS_NEW_TIMED_OUT) = '([a-z_0-9]+)'$/gm)]
    assert.deepEqual(named.map(([, reason]) => reason).sort(), ['chats_new_timeout', 'network_error', 'upstream_5xx', 'upstream_broke'])
    for (const [, reason] of named) {
        const counts = watch.summarize(retried(5, `${reason}, something after the comma`)).counts
        assert.equal(counts.get('app.wholeAnswerRetry'), 1, reason)
        assert.equal(counts.get(`app.wholeAnswerRetry.${reason}`), 1, reason)
        assert.equal(counts.get('app.wholeAnswerRetry.delivered'), 1, reason)
        assert.equal(counts.get('app.unclassified.WARN'), undefined, reason)
        assert.equal(counts.get('app.unclassified.INFO'), undefined, reason)
    }
})

test('a retry that was not delivered is not told from the lines alone — what ended it is, where it always was (Qwen2API-jk9)', () => {
    // The retry's second attempt died under the application: that failure has its own line, as before.
    const failed = watch.render(watch.summarize([
        ...STARTUP,
        ...generation(1, { ending: 'egress_failed' }),
        ...retried(1, 'upstream_broke, egress_failed', false),
        // What the Bun runtime prints after it, dump included.
        appLine(1, 'ERROR', 'CHAT', '❌ 非流式聊天处理错误'),
        'error: signin-worker egress: egress_failed (In-page fetch failed (network_error).)',
        ...generation(20)
    ]))
    assert.equal(failed.verdict, 'LOOK')
    assert.deepEqual(failed.why, ['1 answer(s) failed while the application handled them: 0 with a stream, 1 without', '1 stream(s) ended with an error'])
    assert.equal(watch.summarize([
        appLine(1, 'WARN', 'REQUEST', '⚠️ 非流式整体重试 (原因: upstream_broke, egress_failed)'),
        appLine(1, 'ERROR', 'CHAT', '❌ 非流式聊天处理错误')
    ]).counts.get('app.unclassified.ERROR'), undefined)
})

// Since Qwen2API-0c6 and Qwen2API-nch (2026-11-26): what the worker says beyond a status, and
// what the app says of an answer a reload cut.

test('a refusal qwen.ai put in the body of a 2xx is counted as the refusal it is, and said — not as a 200 (Qwen2API-0c6)', () => {
    // What the worker prints since Qwen2API-0c6. Before, the line of a refused chats/new read exactly like an accepted one (twice in the hour of 2026-11-26).
    const lines = [
        ...generation(1, { first: true }),
        `${at(11)} egress /api/v2/chats/new -> 200 (1/16 pages) — code unauthorized`,
        `${at(11)} request POST /egress -> 200 4ms`,
        `${at(11)} renew ok (forced) (1 sessions)`,
        `${at(11)} egress /api/v2/chats/new -> 200 (1/16 pages)`,
        `${at(11)} egress-stream ${COMPLETIONS} -> 200 (900 ms, 1/16 pages)`,
        `${at(11)} egress-stream ${COMPLETIONS} end (5200 ms)`,
        `${at(12)} egress /api/v2/files/parse/status -> 200 (1/16 pages) — code ParseFailed`,
        `${at(12)} egress /api/v1/tasks/status/x -> 200 (1/16 pages) — code FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x`,
        // A refusal that names no code is a refusal all the same; and a path is a path, dots or no dots.
        `${at(13)} egress /api/v2/chats/new -> 200 (1/16 pages) — refused, no code`,
        `${at(13)} egress /api/v2.1/tasks/status/x -> 200 (1/16 pages) — code RGV587_ERROR::SM::x`,
        // A code with a separator of the worker's own in it is not cut at it.
        `${at(13)} egress /api/v2/chats/new -> 200 (1/16 pages) — code a; b`,
        // Not a 2xx: said by its status, as before. What it quotes of a body is not looked into for a code.
        `${at(12)} egress /api/v2/files/getstsToken -> 405 (1/16 pages) — headers: content-type=text/html, x-region-restriction=true; body: <!doctype html><p>405; code in a body</p>`,
        `${at(13)} egress /api/v2/files/getstsToken -> 405 (1/16 pages) — code Method Not Allowed; headers: none; body: {"code":"Method Not Allowed"}`
    ]
    const report = watch.summarize(lines)
    // The accepted ones only.
    assert.equal(report.counts.get('egress.chatsNew.200'), 2)
    assert.equal(report.counts.get('egress.chatsNew.refused.unauthorized'), 1)
    assert.equal(report.counts.get('egress.chatsNew.refused.no_code'), 1)
    assert.equal(report.counts.get('egress./api/v2/files/parse/status.refused.ParseFailed'), 1)
    assert.equal(report.counts.get('egress./api/v1/tasks/status/x.refused.FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x'), 1)
    assert.equal(report.counts.get('egress./api/v2.1/tasks/status/x.refused.RGV587_ERROR::SM::x'), 1)
    assert.equal(report.counts.get('egress.chatsNew.refused.a; b'), 1)
    assert.equal(report.counts.get('egress./api/v2/files/getstsToken.405'), 2)
    assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
    const { verdict, why, text } = watch.render(report)
    assert.equal(verdict, 'LOOK')
    assert.ok(why.includes('qwen.ai refused 6 call(s) in the body of a 2xx: chats/new unauthorized 1, ' +
        '/api/v2/files/parse/status ParseFailed 1, /api/v1/tasks/status/x FAIL_SYS_USER_VALIDATE | RGV587_ERROR::SM::x 1, ' +
        'chats/new no_code 1, /api/v2.1/tasks/status/x RGV587_ERROR::SM::x 1, chats/new a; b 1'), why.join('\n'))
    assert.ok(why.includes('egress./api/v2/files/getstsToken.405: 2'), why.join('\n'))
    assert.match(text, /refused\.unauthorized {2}1/)
})

test('a challenge page that is no 2xx is still a challenge, whatever is quoted after it', () => {
    const report = watch.summarize([
        `${at(5)} egress /api/v2/chats/new -> 403 (1/16 pages) — WAF challenge page — headers: server=Tengine; body: <html>…`
    ])
    assert.equal(report.counts.get('egress.chatsNew.challenge'), 1)
    assert.equal(report.counts.get('egress.chatsNew.403'), undefined)
    assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
})

test('the worker’s new lines are counted: a page’s token renewed in place, a navigation that waited, a load that waited for its turn', () => {
    const lines = [
        `${at(0)} resident-open ok (1/16 pages, front-end 0.3.50)`,
        `${at(0)} page-load waited (12340 ms)`,
        // A line longer than its limit, packed closer: said so.
        `${at(15)} page-load waited (119300 ms, a long line packed)`,
        `${at(10)} token-refresh ok (412 ms, 15 min left)`,
        `${at(20)} token-refresh ok (380 ms, 15 min left, after a wait of 2130 ms)`,
        `${at(25)} resident-wait ended (waited 4312 ms for the page's streams)`,
        ...generation(25),
        `${at(27)} resident-wait ended (waited 900 ms for the page's streams)`,
        `${at(30)} resident-wait 1 still running (waited 20000 ms for the page's streams)`,
        `${at(30)} egress-stream ${COMPLETIONS} -> 200 (900 ms, 1/16 pages)`,
        `${at(30)} egress-stream ${COMPLETIONS} browser_error (20010 ms)`,
        // A renewal answered by a session that turned live while it waited: no page was loaded for it.
        `${at(31)} renew no reload (1 sessions)`
    ]
    const report = watch.summarize(lines)
    assert.equal(report.counts.get('tokenRefresh.ok'), 2)
    assert.equal(report.counts.get('renew.answered'), 1)
    // Two of one and one of the other: told apart, come what may.
    assert.equal(report.counts.get('pageWait.ended'), 2)
    assert.equal(report.counts.get('pageWait.timedOut'), 1)
    assert.equal(report.counts.get('pageLoad.waits'), 2)
    // One of them was made to begin closer than planned: there was more to load than the spacing fits in the limit.
    assert.equal(report.counts.get('pageLoad.packed'), 1)
    assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
    const { text } = watch.render(report)
    assert.match(text, /ok {2}2/)
    assert.match(text, /packed {2}1/)
    assert.match(text, /longest wait for a turn to load a page: 119300 ms/)
    assert.match(text, /longest a navigation waited for the page's streams: 20000 ms/)
    // A wait that ran out cut a stream: that is what is said, not the wait.
    assert.deepEqual(watch.complaints(report), [
        '1 stream(s) ended with an error',
        '1 page load(s) began closer than planned: the line was longer than its limit'
    ])
})

test('a refresh of a page’s token that failed is said, by why', () => {
    for (const [line, name] of [
        ['token-refresh failed (refused, status 401, code unauthorized, 12 ms)', 'tokenRefresh.failed.refused'],
        ['token-refresh failed (refused, status 200, code unauthorized, 12 ms, after a wait of 2130 ms)', 'tokenRefresh.failed.refused'],
        ['token-refresh failed (network_error, 3 ms)', 'tokenRefresh.failed.network_error'],
        ['token-refresh failed (timeout, 10002 ms)', 'tokenRefresh.failed.timeout'],
        ['token-refresh failed (the page did not answer, 15000 ms)', 'tokenRefresh.failed.no answer']
    ]) {
        const report = watch.summarize([`${at(5)} ${line}`, ...generation(5)])
        assert.equal(report.counts.get(name), 1, line)
        assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
        assert.deepEqual(watch.complaints(report), ["a page's token was not renewed 1 time(s)"], line)
    }
    // A line of a shape it does not know is said as such.
    for (const line of ['token-refresh something else', 'resident-wait for a while', 'page-load waited (a while)']) {
        assert.equal(watch.summarize([`${at(5)} ${line}`]).counts.get('unparsed.worker'), 1, line)
    }
})

test('the app’s own lines after a page was reloaded under its answers are counted as what they are (Qwen2API-nch)', () => {
    // What the application logged in the run without a network (NOTES Qwen2API-nch, "26.11, 09:45 UTC"): what the Bun runtime prints, dump included.
    const lines = [
        ...generation(1),
        appLine(1, 'WARN', 'REQUEST', '⚠️ 聊天请求传输错误 (尝试 1/2, code=ECONNRESET): signin-worker egress: browser_error (The resident page could not run the request.)'),
        appLine(1, 'WARN', 'REQUEST', '⚠️ 聊天请求传输错误 (尝试 1/2, code=ECONNRESET): signin-worker egress: browser_error (Signin worker rejected the request.)'),
        appLine(1, 'ERROR', 'CHAT', '❌ 非流式聊天处理错误'),
        '223 | // What qwen.ai did, or the road to it, as the page reports it.',
        'error: signin-worker egress: browser_error (The resident page could not run the request.)',
        appLine(1, 'ERROR', 'CHAT', '❌ 聊天处理错误'),
        `${at(1)} egress-stream ${COMPLETIONS} browser_error (1465 ms)`,
        `${at(1)} request POST /egress -> 500 1460ms`
    ]
    const report = watch.summarize(lines)
    assert.equal(report.counts.get('app.retried'), 2)
    assert.equal(report.counts.get('app.chatFailed'), 1)
    assert.equal(report.counts.get('app.wholeAnswerFailed'), 1)
    assert.equal(report.counts.get('app.unclassified.ERROR'), undefined)
    assert.equal(report.counts.get('app.unclassified.WARN'), undefined)
    assert.equal(report.unknown.size, 0)
    assert.deepEqual(watch.complaints(report), [
        '2 answer(s) failed while the application handled them: 1 with a stream, 1 without',
        'the worker answered 1 egress call(s) with HTTP 500',
        '1 stream(s) ended with an error'
    ])
})
