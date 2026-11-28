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
        [read('src/utils/whole-answer-retry.js'), 'logger.info(`非流式整体重试成功 (原因: ${reason})`, \'REQUEST\')'],
        // Since Qwen2API-j5f (2026-11-28): the lines of 27.11, and the limits its thresholds come from.
        [read('src/controllers/chat.image.video.js'), "logger.error('图片/视频主流程异常', 'CHAT', '', buildAxiosErrorLog(error))"],
        [read('src/controllers/chat.image.video.js'), "logger.error('OpenAI 图片生成端点处理失败', 'CHAT', '', error)"],
        // The rest of the family by the code: the request's own line, and the lines of the edit endpoint, the video
        // endpoint and the image/video chat route.
        [read('src/controllers/chat.image.video.js'), "logger.error('图片/视频请求失败', 'CHAT', '', buildAxiosErrorLog(error))"],
        [read('src/controllers/chat.image.video.js'), "logger.error('OpenAI 图片编辑端点处理失败', 'CHAT', '', error)"],
        [read('src/controllers/chat.image.video.js'), "logger.error('OpenAI 视频生成端点处理失败', 'CHAT', '', error)"],
        [read('src/controllers/chat.image.video.js'), "logger.error('图片视频资源处理错误', 'CHAT', '', error)"],
        // The Agent routes' lines: what a removed account's request ends with there, a correcting round's chats/new having been out.
        [read('src/controllers/chat.js'), "logger.error('OpenAI Agent 回合处理失败', 'AGENT', '', error)"],
        [read('src/controllers/chat.js'), "logger.error('OpenAI 非流式 Agent 回合处理失败', 'AGENT', '', error)"],
        [read('src/controllers/anthropic.js'), "logger.error('Anthropic Messages 处理错误', 'ANTHROPIC', '', error)"],
        [persistence, 'logger.warn(`v2 会话持久化失败 (${email})——重启后需重新登录`, \'V2SESSION\')'],
        [request, "logger.error(`发送聊天请求失败: 账户额度已耗尽`, 'REQUEST', '', lastError.message)"],
        [request, 'logger.error(`发送聊天请求失败: completions через signin-worker не прошёл (${lastError.workerCode}): ${lastError.message}`, \'REQUEST\')'],
        [request, "logger.error('发送聊天请求失败', 'REQUEST', '', lastError.message)"],
        [read('src/utils/model-map.js'), 'Model "${safeName}" has no MODEL_MAP entry, using "${model}" (${via})`'],
        [egress, 'was removed from the app while its request was out on it; the request ends here (${email})'],
        [egress, "const TRANSPORT = 'upstream_transport_error'"],
        [egress, 'return new ChatCreationError(TRANSPORT, 503)'],
        [egress, 'const CHAT_TIMEOUT_MS = 30000'],
        [egress, 'const JSON_TIMEOUT_MS = 30000'],
        // The lines between the kinds of an egress call's 504 are these limits (readWorkerLine).
        [egress, 'const COMPLETIONS_TIMEOUT_MS = 10 * 60 * 1000'],
        [read('src/controllers/chat.image.video.js'), 'const GENERATION_TIMEOUT_MS = 1000 * 60 * 5'],
        [read('src/controllers/chat.image.video.js'), 'account, timeoutMs: GENERATION_TIMEOUT_MS'],
        [worker, 'egressMaxTimeoutMs: overrides.egressMaxTimeoutMs ?? envInt(\'SIGNIN_EGRESS_MAX_TIMEOUT_MS\', 600000)'],
        [read('src/utils/account.js'), "deferred: '，浏览器配置稍后删除'"],
        [read('src/utils/account.js'), "`页面${forgotten.page ? '已关闭' : '本无'}${FORGET_PROFILE_NOTE[forgotten.profile] || ''}）`"],
        [worker, "`${session ? 'session' : 'no session'}, ${page ? 'page' : 'no page'}, profile ${profile}`"],
        [worker, '`, a ${pending} still running`'],
        [worker, "`profile not removed (${error.code || 'error'})`"],
        [worker, "`profile not removed after the pause (${error.code || 'error'})`"],
        [worker, "`profile ${profile} after the pause (${sessions.size} sessions)`"],
        [worker, "'a mark could not be read: its profile stays as it is'"],
        [worker, "'a mark that names no profile of its own was left alone'"]
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

// Since Qwen2API-j5f (2026-11-28): what the logs of 27.11 showed. The worker's clock is ISO, to the millisecond;
// the app's is the same moment without the zone (src/utils/logger.js#formatTimestamp). On production both
// containers take the host's time, which is UTC: the counter reads the app's lines as that.
const MOMENT = Date.parse('2026-11-24T10:20:18.321Z')
const workerAt = ms => new Date(ms).toISOString()
const said = (ms, level, module, message) =>
    `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} [${level}] [${module}] ${message}`
const noUnknown = report => {
    assert.equal(report.unknown.size, 0)
    assert.equal(report.counts.get('app.unclassified.ERROR'), undefined)
    assert.equal(report.counts.get('app.unclassified.WARN'), undefined)
    assert.equal([...report.counts].filter(([name]) => name.startsWith('unparsed.')).length, 0)
}

// The worker, of a reload: a navigation waited for the page's streams up to its limit — 20 s —, and went on.
const cut = ms => `${workerAt(ms)} resident-wait 1 still running (waited 20013 ms for the page's streams)`
// The pair one image request writes when a reload under its limit cut the generation (the client gets a 503):
// the main flow's line, and the OpenAI image endpoint's — as the logger prints them, emoji in front and the
// error on the lines after the first. As written on 27.11 (rollout-a).
const mediaPair = ms => [
    said(ms, 'ERROR', 'CHAT', '❌ 图片/视频主流程异常'),
    '  message: "signin-worker egress: browser_error (The resident page could not run the request.)",',
    '  code: "ECONNRESET",',
    said(ms, 'ERROR', 'CHAT', '❌ OpenAI 图片生成端点处理失败'),
    '  status: 503,'
]
// The app writes its line to the second; an offset is where the worker's line lies from that second.
const APP = Date.parse('2026-11-24T10:20:18.000Z')

test('a picture or a video a reload cut under its wait is named and not complained of; without such a wait it is said (Qwen2API-nch)', () => {
    const read = (offsets, media = mediaPair(APP)) => {
        const report = watch.summarize([...offsets.map(offset => cut(APP + offset)), ...media, ...generation(30)])
        return { report, ...watch.render(report) }
    }
    // Explained: the wait ran out under the generation — in the same second (as on 27.11: the worker at .321),
    // up to 30 s before the app's line (a slow reload), and up to a second after it (the app writes no fractions).
    for (const offset of [321, -30000, 1000]) {
        const { report, verdict, why, text } = read([offset])
        assert.equal(report.counts.get('app.mediaCutByReload'), 2, String(offset))
        assert.equal(report.counts.get('app.mediaFailed'), undefined, String(offset))
        noUnknown(report)
        assert.equal(verdict, 'OK', `${offset}: ${why.join('\n')}`)
        assert.match(text, /mediaCutByReload {2}2/)
    }
    // Not explained: no such wait, one just outside the window on either side — a millisecond before its
    // 30 s, a millisecond after its second —, and ones far outside.
    for (const [offsets, what] of [[[], 'no wait'], [[-30001], '30.001 s before'], [[1001], '1.001 s after'],
        [[-31000], '31 s before'], [[2000], '2 s after']]) {
        const { report, verdict, why } = read(offsets)
        assert.equal(report.counts.get('app.mediaFailed'), 2, what)
        assert.equal(report.counts.get('app.mediaCutByReload'), undefined, what)
        noUnknown(report)
        assert.equal(verdict, 'LOOK', what)
        assert.deepEqual(why, ['2 picture/video error line(s) in the app that no reload\'s wait for the page\'s streams explains: ' +
            'the reason is on the lines after'], what)
    }
    // A navigation that waited and had the streams end is no cut: the answer went on whole. Only a wait that
    // ran out explains a line, wherever in the window the ended one lies.
    for (const offset of [321, -30000, 1000]) {
        const ended = watch.summarize([
            `${workerAt(APP + offset)} resident-wait ended (waited 4312 ms for the page's streams)`, ...mediaPair(APP), ...generation(30)
        ])
        assert.equal(ended.counts.get('pageWait.ended'), 1, String(offset))
        assert.equal(ended.counts.get('app.mediaCutByReload'), undefined, String(offset))
        assert.equal(ended.counts.get('app.mediaFailed'), 2, String(offset))
        assert.equal(watch.render(ended).verdict, 'LOOK', String(offset))
    }
    // The app's log alone: the verdict it had when the tool did not know the lines — said by name now.
    const alone = watch.render(watch.summarize(mediaPair(APP)))
    assert.equal(alone.verdict, 'LOOK')
    assert.match(alone.text, /mediaFailed {2}2/)
    assert.doesNotMatch(alone.text, /does not know/)
    // Each line on its own — a route may write one of them alone: a first attempt that failed and was made
    // again leaves the request's line alone (src/controllers/chat.image.video.js) —, explained, and said when
    // nothing explains it: by the same complaint, counting it.
    for (const message of ['❌ 图片/视频请求失败', '❌ 图片/视频主流程异常', '❌ OpenAI 图片生成端点处理失败',
        '❌ OpenAI 图片编辑端点处理失败', '❌ OpenAI 视频生成端点处理失败', '❌ 图片视频资源处理错误']) {
        const explained = read([321], [said(APP, 'ERROR', 'CHAT', message)])
        assert.equal(explained.report.counts.get('app.mediaCutByReload'), 1, message)
        assert.equal(explained.verdict, 'OK', message)
        const unexplained = read([], [said(APP, 'ERROR', 'CHAT', message)])
        assert.equal(unexplained.report.counts.get('app.mediaFailed'), 1, message)
        assert.equal(unexplained.verdict, 'LOOK', message)
        assert.deepEqual(unexplained.why, ['1 picture/video error line(s) in the app that no reload\'s wait for the page\'s streams explains: ' +
            'the reason is on the lines after'], message)
    }
    // Judged by time, never by the order of the feed: the app's log may come first, or the two may be interleaved.
    assert.equal(watch.summarize([...mediaPair(APP), cut(APP + 321), ...generation(30)]).counts.get('app.mediaCutByReload'), 2)
    // A text answer the same reload cut is what it was: a failure the app handled, said as one. The wait is in
    // the feed — read as the navigation's that ran out —, and moves nothing: with it the reasons are those of the
    // same lines without it.
    const textAnswer = [said(APP, 'ERROR', 'CHAT', '❌ 聊天处理错误'), ...generation(30)]
    const cutText = watch.summarize([cut(APP), ...textAnswer])
    assert.equal(cutText.counts.get('pageWait.timedOut'), 1)
    assert.equal(cutText.counts.get('app.chatFailed'), 1)
    assert.equal(cutText.counts.get('app.mediaCutByReload'), undefined)
    assert.deepEqual(watch.complaints(cutText), watch.complaints(watch.summarize(textAnswer)))
    assert.deepEqual(watch.complaints(cutText), ['1 answer(s) failed while the application handled them: 1 with a stream, 0 without'])
    // What the tool keeps for this is its own: the report says counts.
    assert.doesNotMatch(read([321]).text, /cutWaits|mediaFailures/)
})

// What each route writes when a reload under its limit cuts the generation it asked for, as its handler wrote it
// on 28.11 with the stream dying after its first frame — as it did on 27.11: the main flow's line, then the line
// of the route that asked. Of a video, whose answer is read whole inside the request, the request's own line
// comes first; so it does of an image whose stream died before its first frame.
const CUT_ROUTES = [
    ['/v1/images/generations', ['❌ 图片/视频主流程异常', '❌ OpenAI 图片生成端点处理失败']],
    ['/v1/images/edits', ['❌ 图片/视频主流程异常', '❌ OpenAI 图片编辑端点处理失败']],
    ['/v1/videos', ['❌ 图片/视频请求失败', '❌ 图片/视频主流程异常', '❌ OpenAI 视频生成端点处理失败']],
    ['the image/video chat route', ['❌ 图片/视频请求失败', '❌ 图片/视频主流程异常', '❌ 图片视频资源处理错误']],
    ['/v1/images/generations, its stream dead before the first frame',
        ['❌ 图片/视频请求失败', '❌ 图片/视频主流程异常', '❌ OpenAI 图片生成端点处理失败']]
]

test('an edit, a video and the image/video chat route end a cut generation with a line of their own: the one media rule for all of them (Qwen2API-nch)', () => {
    for (const [route, lines] of CUT_ROUTES) {
        const written = lines.map(message => said(APP, 'ERROR', 'CHAT', message))
        const explained = watch.render(watch.summarize([cut(APP + 321), ...written, ...generation(30)]))
        assert.equal(explained.verdict, 'OK', `${route}: ${explained.why.join('\n')}`)
        assert.match(explained.text, new RegExp(`mediaCutByReload {2}${lines.length}\\b`), route)
        // Without such a wait every line of the request is a failure of its own, and the complaint counts them all.
        const unexplained = watch.render(watch.summarize([...written, ...generation(30)]))
        assert.equal(unexplained.verdict, 'LOOK', route)
        assert.match(unexplained.text, new RegExp(`mediaFailed {2}${lines.length}\\b`), route)
        assert.deepEqual(unexplained.why, [`${lines.length} picture/video error line(s) in the app that no reload's wait for the page's streams explains: ` +
            'the reason is on the lines after'], route)
        // The app's log alone reads the same: the lines are known, and named.
        assert.doesNotMatch(unexplained.text, /does not know/, route)
    }
})

test('the app’s time, which carries no zone, is read as UTC whatever zone the machine sits in', () => {
    // Both containers on production take the host's time, which is UTC. The worker's line is ISO with its zone;
    // the app's is the same moment written without one (src/utils/logger.js#formatTimestamp) — read as the
    // machine's own zone, it would move by hours against the worker's, and the pair would never be explained.
    const feed = [cut(MOMENT), ...mediaPair(APP)].join('\n')
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'egress-log-watch.js')], {
            input: feed, encoding: 'utf8', env: { ...process.env, TZ: zone }
        })
        assert.equal(run.status, 0, `${zone}: ${run.stdout}${run.stderr}`)
        assert.match(run.stdout, /mediaCutByReload {2}2/, zone)
    }
})

test('a session the app could not save is counted and is no complaint; the account goes nowhere', () => {
    // src/utils/v2-session-persistence.js: it costs a sign-in after a restart, not this request.
    const report = watch.summarize([
        ...STARTUP,
        ...generation(1),
        said(MOMENT, 'WARN', 'V2SESSION', '⚠️ v2 会话持久化失败 (kept@example.invalid)——重启后需重新登录'),
        said(MOMENT, 'WARN', 'V2SESSION', '⚠️ v2 会话持久化失败 (other@example.invalid)——重启后需重新登录')
    ])
    assert.equal(report.counts.get('app.sessionNotSaved'), 2)
    noUnknown(report)
    const { verdict, why, text } = watch.render(report)
    assert.equal(verdict, 'OK', why.join('\n'))
    assert.deepEqual(why, [])
    assert.match(text, /sessionNotSaved {2}2/)
    assert.doesNotMatch(text, /example\.invalid/)
})

test('a chat request that failed on every attempt is counted by what failed, and said — its client got an error', () => {
    // As the logger prints them (src/utils/request.js): of the bare line the message is on the line after — on the
    // console as it is, in the file log under the quotes the logger puts round a string.
    const failed = (message = '❌ 发送聊天请求失败') => said(MOMENT, 'ERROR', 'REQUEST', message)
    const report = watch.summarize([
        ...generation(1),
        failed(), 'Request failed with status code 502',
        failed(), 'Request failed with status code 503',
        failed(), '"Request failed with status code 502"',
        failed('❌ 发送聊天请求失败: 账户额度已耗尽'), 'Too Many Requests',
        failed('❌ 发送聊天请求失败: completions через signin-worker не прошёл (page_fault): signin-worker egress: page_fault'),
        // A message of another shape, and a form with a colon that says something else.
        failed(), 'socket hang up',
        failed('❌ 发送聊天请求失败: по другой причине')
    ])
    assert.equal(report.counts.get('app.chatRequestFailed'), 7)
    assert.equal(report.counts.get('app.chatRequestFailed.502'), 2)
    assert.equal(report.counts.get('app.chatRequestFailed.503'), 1)
    assert.equal(report.counts.get('app.chatRequestFailed.quota'), 1)
    assert.equal(report.counts.get('app.chatRequestFailed.worker.page_fault'), 1)
    assert.equal(report.counts.get('app.chatRequestFailed.other'), 2)
    // What the worker did not carry is the worker's refusal as well, as it always was counted.
    assert.equal(report.counts.get('app.workerRefused.completions.page_fault'), 1)
    noUnknown(report)
    // The messages stay "other" lines: nothing of the line counts moved.
    assert.equal(report.lines.other, 5)
    assert.equal(report.lines.app, 7)
    const { verdict, why, text } = watch.render(report)
    assert.equal(verdict, 'LOOK')
    // Said once: the one the worker did not carry is said by the worker's own reason, and counted above.
    assert.deepEqual(why, [
        'the worker could not serve 1 call(s)',
        '6 chat request(s) failed: 2 with status 502, 1 with status 503, 2 otherwise, 1 for a spent quota'
    ])
    assert.match(text, /chatRequestFailed {2}7/)
    assert.match(text, /chatRequestFailed\.502 {2}2/)
    // A feed that ends on the bare line, or one whose next line is a log line: no message came, it is "otherwise".
    for (const lines of [[failed()], [failed(), `${at(5)} resident-open ok (1/16 pages, front-end 0.3.50)`]]) {
        const bare = watch.summarize(lines)
        assert.equal(bare.counts.get('app.chatRequestFailed.other'), 1)
        assert.equal(bare.counts.get('app.chatRequestFailed'), 1)
        // And nothing is left waited for: a report fed again reads its next feed on its own.
        assert.equal(bare.chatRequestMessage, false)
    }
    // The first line of the next feed would have read as the message of the last line of the one before.
    const fed = watch.summarize([failed()])
    watch.summarize(['Request failed with status code 502', failed(), 'Request failed with status code 503'], fed)
    assert.equal(fed.counts.get('app.chatRequestFailed'), 2)
    assert.equal(fed.counts.get('app.chatRequestFailed.other'), 1)
    assert.equal(fed.counts.get('app.chatRequestFailed.502'), undefined)
    assert.equal(fed.counts.get('app.chatRequestFailed.503'), 1)
})

test('a model with no MODEL_MAP entry is counted once for all names, and is no complaint', () => {
    // src/utils/model-map.js: a client asked for a model the app does not know, and got the map's stand-in.
    const warned = (name, via) => said(MOMENT, 'WARN', 'MODEL', `⚠️ Model "${name}" has no MODEL_MAP entry, using "qwen3.8-max" (${via}))`)
    const report = watch.summarize([
        ...STARTUP,
        ...generation(1),
        warned('qwen3-vl-plus', 'MODEL_MAP "*" entry'),
        warned('qwen3.5-flash', 'MODEL_MAP "*" entry'),
        warned('qwen3.6-plus', 'MODEL_MAP "*" entry'),
        warned('a-model-nobody-knows', 'first upstream t2t model; add a MODEL_MAP entry to pin it')
    ])
    assert.equal(report.counts.get('app.modelMapFallback'), 4)
    noUnknown(report)
    // No name a client sent becomes a name of the report's: the listing would grow without end.
    assert.deepEqual([...report.counts.keys()].filter(name => /qwen|nobody|wildcard/.test(name)), [])
    const { verdict, why, text } = watch.render(report)
    assert.equal(verdict, 'OK', why.join('\n'))
    assert.match(text, /modelMapFallback {2}4/)
})

test('an answer that failed on the Anthropic route is said with the others, as its own count', () => {
    // src/controllers/anthropic.js: one handler for an answer with a stream and without.
    const failed = (...messages) => watch.render(watch.summarize([
        ...generation(1),
        ...messages.map(([module, message]) => said(MOMENT, 'ERROR', module, `❌ ${message}`))
    ]))
    // With none of them the reason is the line it was.
    assert.deepEqual(failed(['CHAT', '聊天处理错误'], ['CHAT', '非流式聊天处理错误']).why,
        ['2 answer(s) failed while the application handled them: 1 with a stream, 1 without'])
    assert.deepEqual(failed(['ANTHROPIC', 'Anthropic Messages 处理错误']).why,
        ['1 answer(s) failed while the application handled them: 0 with a stream, 0 without, 1 on the Anthropic route'])
    assert.deepEqual(failed(['CHAT', '聊天处理错误'], ['ANTHROPIC', 'Anthropic Messages 处理错误'], ['ANTHROPIC', 'Anthropic Messages 处理错误']).why,
        ['3 answer(s) failed while the application handled them: 1 with a stream, 0 without, 2 on the Anthropic route'])
    const report = watch.summarize([said(MOMENT, 'ERROR', 'ANTHROPIC', '❌ Anthropic Messages 处理错误')])
    assert.equal(report.counts.get('app.anthropicFailed'), 1)
    noUnknown(report)
    assert.match(failed(['ANTHROPIC', 'Anthropic Messages 处理错误']).text, /anthropicFailed {2}1/)
})

// Since Qwen2API-u50, read since Qwen2API-j5f: a request the app ended because its account was removed meanwhile.
// What the app prints of one, route by route, as its handlers wrote it on 28.11 with the account removed while its
// chats/new was out on the page: the WARN, then the chat that could not be made, then the handler's own line, then
// what the runtime prints of the error — the first three in one turn of the event loop, nothing between them.
// Of the Agent routes the chats/new that was out is a correcting round's: the first round the gate refused.
const REMOVED = '⚠️ The account was removed from the app while its request was out on it; the request ends here (gone@example.invalid)'
const NO_CHAT = '❌ Qwen chat creation failed: category=upstream_transport_error, status=503'
// What Bun prints after the handler's line: the error itself.
const CHAT_ERROR = [
    'ChatCreationError: Qwen chat creation transport failed',
    '    at removedRequest (/app/src/utils/browser-egress.js:149:12)',
    '    at async generateChatID (/app/src/utils/request.js:1002:45) {',
    '  code: "upstream_transport_error",',
    '}'
]
// ...and what it prints of the plain object the media controller throws for a chat that could not be made: the
// main flow logs nothing of its own then (src/controllers/chat.image.video.js), the endpoint's catch does.
const ENDPOINT_ERROR = [
    '{',
    '  status: 503,',
    '  error: "Qwen chat creation transport failed",',
    '  code: "upstream_transport_error",',
    '  chatCreation: true',
    '}'
]
// The handler's line by route, with the module the logger is given there, and what the runtime prints after it.
const HANDLER_LINES = [
    ['the OpenAI chat routes, with a stream and without', 'CHAT', '❌ 聊天处理错误', CHAT_ERROR],
    ['the Anthropic route, with a stream and without', 'ANTHROPIC', '❌ Anthropic Messages 处理错误', CHAT_ERROR],
    ['/v1/images/generations', 'CHAT', '❌ OpenAI 图片生成端点处理失败', ENDPOINT_ERROR],
    ['/v1/images/edits', 'CHAT', '❌ OpenAI 图片编辑端点处理失败', ENDPOINT_ERROR],
    ['/v1/videos', 'CHAT', '❌ OpenAI 视频生成端点处理失败', ENDPOINT_ERROR],
    // The image/video chat route (src/controllers/chat.image.video.js) and the two Agent routes (src/controllers/chat.js).
    ['the image/video chat route', 'CHAT', '❌ 图片视频资源处理错误', ENDPOINT_ERROR],
    ['the OpenAI Agent route, with a stream', 'AGENT', '❌ OpenAI Agent 回合处理失败', CHAT_ERROR],
    ['the OpenAI Agent route, without a stream', 'AGENT', '❌ OpenAI 非流式 Agent 回合处理失败', CHAT_ERROR]
]
// One such request as the app prints it, from its WARN on.
const removedRequest = ([, module, line, error]) => [
    said(MOMENT, 'WARN', 'CHAT', REMOVED),
    said(MOMENT, 'ERROR', 'CHAT', NO_CHAT),
    said(MOMENT, 'ERROR', module, line),
    ...error
]
// What no line of such a request is counted as: the request did not reach qwen.ai, and the account is gone.
const NOT_OF_ITS_OWN = ['app.chatFailed', 'app.wholeAnswerFailed', 'app.anthropicFailed', 'app.chatsNewRefused.upstream_transport_error',
    'app.mediaCutByReload', 'app.mediaFailed']

test('a request the app ended because its account was removed is counted as that — the lines it writes, by route — and is no complaint (Qwen2API-u50)', () => {
    for (const handler of HANDLER_LINES) {
        const route = handler[0]
        const report = watch.summarize([...generation(1), ...removedRequest(handler)])
        assert.equal(report.counts.get('app.removedAccount'), 1, route)
        assert.equal(report.counts.get('app.removedAccount.chatsNew'), 1, route)
        assert.equal(report.counts.get('app.removedAccount.answerFailed'), 1, route)
        // Not as a refusal of chats/new, not as an answer that failed, not as a picture that failed...
        for (const name of NOT_OF_ITS_OWN) assert.equal(report.counts.get(name), undefined, `${route}: ${name}`)
        // ...and not as an error nobody knows: a line of a route this tool does not read is not listed either.
        noUnknown(report)
        // Only what the runtime printed of the error is "other".
        assert.equal(report.lines.other, handler[3].length, route)
        const { verdict, why, text } = watch.render(report)
        assert.deepEqual(why, [], route)
        assert.equal(verdict, 'OK', route)
        assert.match(text, /removedAccount\.answerFailed {2}1/)
        assert.doesNotMatch(text, /gone@example\.invalid|was removed/, route)
    }

    // Without the WARN before them the same lines are what they always were.
    const alone = handler => watch.render(watch.summarize([
        said(MOMENT, 'ERROR', 'CHAT', NO_CHAT),
        said(MOMENT, 'ERROR', handler[1], handler[2]),
        ...handler[3]
    ]))
    const FAILED = '1 answer(s) failed while the application handled them'
    const PICTURE = '1 picture/video error line(s) in the app that no reload\'s wait for the page\'s streams explains: the reason is on the lines after'
    const UNKNOWN = '1 error line(s) this tool does not know (listed below)'
    const REFUSED = 'chats/new failed otherwise: upstream_transport_error 1'
    assert.deepEqual(alone(HANDLER_LINES[0]).why, [REFUSED, `${FAILED}: 1 with a stream, 0 without`])
    assert.deepEqual(alone(HANDLER_LINES[1]).why, [REFUSED, `${FAILED}: 0 with a stream, 0 without, 1 on the Anthropic route`])
    // The three media endpoints' lines, and the image/video chat route's, are the picture or video that failed
    // (the media rule, above); the Agent routes' lines are no shape this tool knows.
    for (const handler of HANDLER_LINES.slice(2, 6)) assert.deepEqual(alone(handler).why, [REFUSED, PICTURE], handler[0])
    for (const handler of HANDLER_LINES.slice(6)) assert.deepEqual(alone(handler).why, [REFUSED, UNKNOWN], handler[0])
    assert.equal(alone(HANDLER_LINES[7]).verdict, 'LOOK')
})

test('the echo of a removed account’s request is counted, not chained — a WARN, its chats/new line, its handler’s line — each within two seconds of the one before, and no other line of the app’s between', () => {
    const counts = lines => watch.summarize(lines).counts
    const WARN = () => said(MOMENT, 'WARN', 'CHAT', REMOVED)
    const NO_CHAT_LINE = () => said(MOMENT, 'ERROR', 'CHAT', NO_CHAT)
    const CHAT = () => said(MOMENT, 'ERROR', 'CHAT', '❌ 聊天处理错误')
    const ECHO = () => [NO_CHAT_LINE(), CHAT()]

    // After the echo an unrelated failure is another request's, and is said as always. (While the request was
    // held open for ten seconds, the next line of a handler was taken for its echo.) With what the runtime
    // printed of the error between the two, and without it — a feed of the app's WARN and ERROR lines alone.
    for (const printed of [CHAT_ERROR, []]) {
        const hole = watch.summarize([...generation(1), WARN(), ...ECHO(), ...printed, said(MOMENT + 500, 'ERROR', 'CHAT', '❌ 聊天处理错误')])
        assert.equal(hole.counts.get('app.removedAccount.answerFailed'), 1)
        assert.equal(hole.counts.get('app.chatFailed'), 1)
        assert.deepEqual(watch.complaints(hole), ['1 answer(s) failed while the application handled them: 1 with a stream, 0 without'])
    }
    // Nor is another request's chats/new that failed the same way right after: a refusal of its own, said as one.
    const after = watch.summarize([...generation(1), WARN(), ...ECHO(),
        said(MOMENT + 500, 'ERROR', 'CHAT', NO_CHAT), said(MOMENT + 500, 'ERROR', 'CHAT', '❌ 聊天处理错误')])
    assert.equal(after.counts.get('app.removedAccount.chatsNew'), 1)
    assert.equal(after.counts.get('app.removedAccount.answerFailed'), 1)
    assert.equal(after.counts.get('app.chatsNewRefused.upstream_transport_error'), 1)
    assert.equal(after.counts.get('app.chatFailed'), 1)
    assert.deepEqual(watch.complaints(after), [
        'chats/new failed otherwise: upstream_transport_error 1',
        '1 answer(s) failed while the application handled them: 1 with a stream, 0 without'
    ])

    // The bound in time stands where lines of neither side's might come between: the next line of the run must
    // come within two seconds of the last — the lines of one request share a second, except across a boundary.
    for (const [later, taken] of [[1000, true], [2000, true], [3000, false]]) {
        const late = counts([WARN(), said(MOMENT + later, 'ERROR', 'CHAT', NO_CHAT), said(MOMENT + later + 500, 'ERROR', 'CHAT', '❌ 聊天处理错误')])
        assert.equal(late.get('app.removedAccount.chatsNew'), taken ? 1 : undefined, String(later))
        assert.equal(late.get('app.removedAccount.answerFailed'), taken ? 1 : undefined, String(later))
        assert.equal(late.get('app.chatsNewRefused.upstream_transport_error'), taken ? undefined : 1, String(later))
        assert.equal(late.get('app.chatFailed'), taken ? undefined : 1, String(later))
    }
    // ...and between the lines of the echo.
    for (const [later, taken] of [[1000, true], [3000, false]]) {
        const late = counts([WARN(), NO_CHAT_LINE(), said(MOMENT + later, 'ERROR', 'CHAT', '❌ 聊天处理错误')])
        assert.equal(late.get('app.removedAccount.chatsNew'), 1, String(later))
        assert.equal(late.get('app.removedAccount.answerFailed'), taken ? 1 : undefined, String(later))
        assert.equal(late.get('app.chatFailed'), taken ? undefined : 1, String(later))
    }
    // The clock of the bound is the last line of the run's, not the WARN's: a handler's line two seconds after
    // the chat's is within it, three seconds after the WARN though that is.
    const moved = counts([WARN(), said(MOMENT + 1000, 'ERROR', 'CHAT', NO_CHAT), said(MOMENT + 3000, 'ERROR', 'CHAT', '❌ 聊天处理错误')])
    assert.equal(moved.get('app.removedAccount.chatsNew'), 1)
    assert.equal(moved.get('app.removedAccount.answerFailed'), 1)
    assert.equal(moved.get('app.chatFailed'), undefined)
    // A second WARN keeps the same clock: one too late opens a run of its own, and the first is over.
    const lateWarn = counts([WARN(), said(MOMENT + 3000, 'WARN', 'CHAT', REMOVED), NO_CHAT_LINE(), CHAT()])
    assert.equal(lateWarn.get('app.removedAccount'), 2)
    assert.equal(lateWarn.get('app.removedAccount.chatsNew'), 1)
    assert.equal(lateWarn.get('app.removedAccount.answerFailed'), 1)
    assert.equal(lateWarn.get('app.chatsNewRefused.upstream_transport_error'), undefined)

    // Blank lines, lines of neither side's log — what the runtime printed of an error, the start-up record —,
    // and the worker's do not close it: in one feed of both logs a line of the app's stdout may land between
    // its lines on stderr.
    const kept = counts([
        WARN(), '', '   ', '{', '  chatCreationTransport: "browser",',
        `${at(1)} request POST /forget -> 200 115ms`, '', `${at(1)} resident-close forgotten (0 pages)`,
        NO_CHAT_LINE(),
        'ChatCreationError: Qwen chat creation transport failed', `${at(1)} egress-stream ${COMPLETIONS} end (5200 ms)`, '',
        said(MOMENT, 'ERROR', 'ANTHROPIC', '❌ Anthropic Messages 处理错误')
    ])
    assert.equal(kept.get('app.removedAccount.chatsNew'), 1)
    assert.equal(kept.get('app.removedAccount.answerFailed'), 1)
    assert.equal(kept.get('app.anthropicFailed'), undefined)

    // Any other line of the app's between closes the run, wherever it comes — before the chat's line, or between
    // it and the handler's, where any ERROR would have been taken: what follows is read as it always was.
    for (const between of [
        said(MOMENT, 'INFO', 'ACCOUNT', '📝 something the app says in between'),
        said(MOMENT, 'WARN', 'V2SESSION', '⚠️ v2 会话失效 (gone@example.invalid, 原因: 401)——触发 signin-worker 续期')
    ]) {
        const cutEarly = counts([WARN(), between, ...ECHO()])
        assert.equal(cutEarly.get('app.removedAccount.chatsNew'), undefined)
        assert.equal(cutEarly.get('app.chatsNewRefused.upstream_transport_error'), 1)
        assert.equal(cutEarly.get('app.chatFailed'), 1)
        const cutLate = counts([WARN(), NO_CHAT_LINE(), between, CHAT()])
        assert.equal(cutLate.get('app.removedAccount.chatsNew'), 1)
        for (const cut of [cutEarly, cutLate]) assert.equal(cut.get('app.removedAccount.answerFailed'), undefined)
    }
    // So does an ERROR that fits neither: at most two ERROR lines a request — a handler's where the chat's was
    // due is another's...
    const early = counts([WARN(), CHAT(), NO_CHAT_LINE(), CHAT()])
    assert.equal(early.get('app.removedAccount.chatsNew'), undefined)
    assert.equal(early.get('app.removedAccount.answerFailed'), undefined)
    assert.equal(early.get('app.chatFailed'), 2)
    assert.equal(early.get('app.chatsNewRefused.upstream_transport_error'), 1)
    // ...and a chats/new line of another category: the error a removed account's request throws is the transport one.
    const other = counts([WARN(), said(MOMENT, 'ERROR', 'CHAT', '❌ Qwen chat creation failed: category=upstream_session_unauthorized, status=401'), NO_CHAT_LINE(), CHAT()])
    assert.equal(other.get('app.chatsNewRefused.upstream_session_unauthorized'), 1)
    assert.equal(other.get('app.chatsNewRefused.upstream_transport_error'), 1)
    assert.equal(other.get('app.removedAccount.chatsNew'), undefined)
    assert.equal(other.get('app.removedAccount.answerFailed'), undefined)
    assert.equal(other.get('app.chatFailed'), 1)

    // The handler's line is any ERROR line the app writes where it is due, whatever its message: one this tool
    // does not know is not listed as unknown, and one it does know is not counted as it would be elsewhere.
    for (const [third, elsewhere] of [
        ['❌ 非流式聊天处理错误', 'app.wholeAnswerFailed'],
        ['❌ a line of a route this tool does not read', 'app.unclassified.ERROR'],
        ['❌ Qwen chat creation failed: category=upstream_session_unauthorized, status=401', 'app.chatsNewRefused.upstream_session_unauthorized'],
        // A second chats/new line where the handler's was due is the handler's in its turn.
        [NO_CHAT, 'app.chatsNewRefused.upstream_transport_error']
    ]) {
        const taken = watch.summarize([WARN(), NO_CHAT_LINE(), said(MOMENT, 'ERROR', 'SOMETHING', third)])
        assert.equal(taken.counts.get('app.removedAccount.chatsNew'), 1, third)
        assert.equal(taken.counts.get('app.removedAccount.answerFailed'), 1, third)
        for (const name of [...NOT_OF_ITS_OWN, elsewhere]) assert.equal(taken.counts.get(name), undefined, `${third}: ${name}`)
        assert.equal(taken.unknown.size, 0, third)
    }
    // A media line so taken is neither a cut by a reload nor a failed picture, a wait lying by or not.
    const media = watch.summarize([cut(MOMENT), ...removedRequest(HANDLER_LINES[2]), ...removedRequest(HANDLER_LINES[3])])
    noUnknown(media)
    assert.equal(media.counts.get('app.mediaCutByReload'), undefined)
    assert.equal(media.counts.get('app.mediaFailed'), undefined)
    assert.equal(media.counts.get('app.removedAccount.answerFailed'), 2)

    // The WARN as the last line of a feed, or the feed cut between the lines: nothing is taken for the echo,
    // nothing is thrown, and what was read stands.
    const last = watch.summarize([...generation(1), WARN()])
    assert.equal(last.counts.get('app.removedAccount'), 1)
    assert.equal(last.counts.get('app.removedAccount.chatsNew'), undefined)
    assert.equal(last.counts.get('app.removedAccount.answerFailed'), undefined)
    assert.deepEqual(watch.render(last).why, [])
    const short = watch.summarize([WARN(), NO_CHAT_LINE()])
    assert.equal(short.counts.get('app.removedAccount.chatsNew'), 1)
    assert.equal(short.counts.get('app.removedAccount.answerFailed'), undefined)
    assert.deepEqual(watch.render(short).why, [])
})

test('two requests of a removed account that continue in one turn of the event loop are each read whole — a count of what is due, not one chain (Qwen2API-u50)', () => {
    const WARN = () => said(MOMENT, 'WARN', 'CHAT', REMOVED)
    const NO_CHAT_LINE = () => said(MOMENT, 'ERROR', 'CHAT', NO_CHAT)
    const CHAT = () => said(MOMENT, 'ERROR', 'CHAT', '❌ 聊天处理错误')
    // Two requests of the account that waited on one renewal continue in one microtask drain, and write their
    // lines as the handlers wrote them on 28.11: WARN, WARN, chats/new, chats/new, handler, handler. Read as one
    // chain, the second chats/new line was taken for a handler's, and both handlers' lines were left as two
    // answers that failed — a LOOK out of nothing. Three requests the same.
    for (const requests of [2, 3]) {
        const report = watch.summarize([
            ...generation(1),
            ...Array.from({ length: requests }, WARN),
            ...Array.from({ length: requests }, NO_CHAT_LINE),
            ...Array.from({ length: requests }, CHAT)
        ])
        assert.equal(report.counts.get('app.removedAccount'), requests)
        assert.equal(report.counts.get('app.removedAccount.chatsNew'), requests)
        assert.equal(report.counts.get('app.removedAccount.answerFailed'), requests)
        for (const name of NOT_OF_ITS_OWN) assert.equal(report.counts.get(name), undefined, name)
        noUnknown(report)
        const { verdict, why, text } = watch.render(report)
        assert.deepEqual(why, [], String(requests))
        assert.equal(verdict, 'OK', String(requests))
        assert.match(text, new RegExp(`removedAccount\\.answerFailed {2}${requests}\\b`))
    }
    // In another order too: a WARN while a run is open adds a request to it.
    const woven = watch.summarize([WARN(), NO_CHAT_LINE(), WARN(), NO_CHAT_LINE(), CHAT(), CHAT()]).counts
    assert.equal(woven.get('app.removedAccount'), 2)
    assert.equal(woven.get('app.removedAccount.chatsNew'), 2)
    assert.equal(woven.get('app.removedAccount.answerFailed'), 2)
    assert.equal(woven.get('app.chatFailed'), undefined)
})

test('a feed of nothing but WARN lines the tool has learned is judged as it was before it knew them', () => {
    // Before Qwen2API-j5f these were `app.unclassified.WARN` — itself a count under `app.`: the feed said OK,
    // never NOTHING TO JUDGE (checked against the tool of main 6497438). A line learned moves to a name of its
    // own and moves no verdict; the two lines of the echo stay in, they stand for ERROR lines that were counted.
    const learned = watch.summarize([
        said(MOMENT, 'WARN', 'V2SESSION', '⚠️ v2 会话持久化失败 (kept@example.invalid)——重启后需重新登录'),
        said(MOMENT, 'WARN', 'MODEL', '⚠️ Model "qwen3-vl-plus" has no MODEL_MAP entry, using "qwen3.8-max" (MODEL_MAP "*" entry)'),
        said(MOMENT, 'WARN', 'CHAT', REMOVED)
    ])
    assert.equal(watch.render(learned).verdict, 'OK')
    assert.equal(watch.render(watch.summarize([said(MOMENT, 'WARN', 'ACCOUNT', '⚠️ a warning nobody classified')])).verdict, 'OK')
    // With the echo lines it is what the request made of them: a feed judged, and no complaint.
    assert.equal(watch.render(watch.summarize(removedRequest(HANDLER_LINES[0]))).verdict, 'OK')
})

test('the worker’s 504s are told apart by how long the call waited, against the limits the app gives its calls: half a minute, five minutes and ten (Qwen2API-jk9, Qwen2API-2ba)', () => {
    // `request POST /egress -> 504 <N>ms`: the line does not say which call it was; the time it took stands
    // against the limits the app gives its calls (src/utils/browser-egress.js, src/controllers/chat.image.video.js):
    // chats/new and the JSON calls half a minute, a picture or video generation five minutes, completions ten.
    // A slow page opening adds to any of them.
    const gaveUp = (duration, route = 'egress') => `${at(5)} request POST /${route} -> 504 ${duration}ms`
    const read = (durations, other = []) => {
        const report = watch.summarize([...other, ...durations.map(duration => gaveUp(duration))])
        return { report, ...watch.render(report) }
    }
    const kind = (report, name) => report.counts.get(`workerHttp.egress.504.${name}`)
    const UNDER = "in under five minutes (a call that did not return from the page in time — chats/new's limit is 30 s; Qwen2API-jk9)"
    const FIVE = 'after five minutes or more (a picture or video generation that did not finish in its limit of five)'
    const TEN = 'after ten minutes or more (completions gave no head — Qwen2API-2ba)'
    // As the worker logged them on 27.11: two in the first hour at about 30 s (the call did not return from the
    // page; the client got a 503), one in the rollout window at about ten minutes (completions gave no head).
    const short = read([30014, 30015])
    assert.equal(short.report.counts.get('workerHttp.egress.504'), 2)
    assert.equal(kind(short.report, 'noAnswer'), 2)
    assert.equal(kind(short.report, 'generation'), undefined)
    assert.equal(kind(short.report, 'noHead'), undefined)
    assert.deepEqual(short.why, [`the worker answered 2 egress call(s) with HTTP 504: 2 ${UNDER}`])
    const long = read([600016])
    assert.equal(long.report.counts.get('workerHttp.egress.504'), 1)
    assert.equal(kind(long.report, 'noHead'), 1)
    assert.deepEqual(long.why, [`the worker answered 1 egress call(s) with HTTP 504: 1 ${TEN}`])
    // A generation that did not finish in its five minutes.
    const generation = read([300016])
    assert.equal(generation.report.counts.get('workerHttp.egress.504'), 1)
    assert.equal(kind(generation.report, 'generation'), 1)
    assert.deepEqual(generation.why, [`the worker answered 1 egress call(s) with HTTP 504: 1 ${FIVE}`])
    // The lines between the kinds are the limits themselves: five minutes, and ten. One below each stays with
    // the kind before; the limit itself belongs to the kind after.
    for (const [duration, name] of [[155014, 'noAnswer'], [299999, 'noAnswer'], [300000, 'generation'], [599999, 'generation'], [600000, 'noHead']]) {
        const { report } = read([duration])
        assert.deepEqual(['noAnswer', 'generation', 'noHead'].filter(each => kind(report, each) === 1), [name], String(duration))
    }
    // All three kinds, each with its number, said in the order of the limits.
    const all = read([30014, 300016, 600016])
    assert.equal(all.report.counts.get('workerHttp.egress.504'), 3)
    assert.deepEqual(all.why, [`the worker answered 3 egress call(s) with HTTP 504: 1 ${UNDER}, 1 ${FIVE}, 1 ${TEN}`])
    assert.match(all.text, /egress\.504 {2}3/)
    assert.match(all.text, /egress\.504\.generation {2}1/)
    // Another status beside them keeps its wording, the kinds said after it.
    assert.deepEqual(read([30014], [`${at(5)} request POST /egress -> 500 12ms`]).why,
        [`the worker answered 2 egress call(s) with HTTP 500 and 504: 1 ${UNDER}`])
    // A 504 of another route of the worker's gets no kind: the limits are the egress calls'.
    const other = watch.summarize([gaveUp(600000, 'renew'), gaveUp(30014, 'session')])
    assert.equal(other.counts.get('workerHttp.renew.504'), 1)
    assert.equal(other.counts.get('workerHttp.session.504'), 1)
    assert.equal(other.counts.get('workerHttp.egress.504'), undefined)
    assert.deepEqual([...other.counts.keys()].filter(name => name.startsWith('workerHttp.egress.504.')), [])
    assert.deepEqual(watch.complaints(other), [])
    // A line that says no time is counted as it was, without the kinds.
    const timeless = watch.summarize([`${at(5)} request POST /egress -> 504 after a while`])
    assert.equal(timeless.counts.get('workerHttp.egress.504'), 1)
    assert.equal(kind(timeless, 'noAnswer'), undefined)
    assert.deepEqual(watch.complaints(timeless), ['the worker answered 1 egress call(s) with HTTP 504'])
})

test('what the worker forgot is counted by what became of the profile — never by the line’s text — and a profile that stayed or a mark that could not be read is said (Qwen2API-2l0, Qwen2API-t8s)', () => {
    // The worker's lines as signin-worker/server.js prints them: the answer of /forget, a removal that failed, a
    // deletion after a pause, and what the start of the worker made of the marks left in the profiles.
    const lines = [
        `${at(1)} forget session, page, profile deleted (2 sessions)`,
        `${at(1)} request POST /forget -> 200 115ms`,
        `${at(2)} forget no session, no page, profile deleted (2 sessions)`,
        `${at(3)} forget session, page, profile kept (1 sessions)`,
        `${at(4)} forget session, page, profile absent (0 sessions)`,
        `${at(5)} forget profile not removed (EBUSY)`,
        `${at(5)} forget session, page, profile left (1 sessions)`,
        // With a pause: the profile goes when it is over.
        `${at(6)} forget session, page, profile deferred (1 sessions)`,
        `${at(8)} forget profile deleted after the pause (1 sessions)`,
        `${at(9)} forget session, page, profile deferred (1 sessions)`,
        `${at(11)} forget profile not removed after the pause (error)`,
        `${at(11)} forget profile left after the pause (1 sessions)`,
        // A sign-in or a renewal of the account outlived /forget's patience: it may leave a session behind.
        `${at(12)} forget session, page, profile kept, a renewal still running (1 sessions)`,
        `${at(13)} forget session, page, profile deferred, a login still running (1 sessions)`,
        // The start of the worker.
        `${at(0)} forget a mark that names no profile of its own was left alone`,
        `${at(0)} forget a mark could not be read: its profile stays as it is`
    ]
    const report = watch.summarize(lines)
    assert.deepEqual(Object.fromEntries([...report.counts].filter(([name]) => name.startsWith('forget.'))), {
        'forget.deleted': 2, 'forget.kept': 2, 'forget.absent': 1, 'forget.left': 1, 'forget.deferred': 3,
        'forget.notRemoved': 1, 'forget.afterThePause.deleted': 1, 'forget.afterThePause.notRemoved': 1,
        'forget.afterThePause.left': 1, 'forget.pending': 2, 'forget.mark.leftAlone': 1, 'forget.mark.unreadable': 1
    })
    // Lines of the worker now — fifteen of /forget and the call's own —, and no longer "other".
    assert.equal(report.lines.worker, 16)
    assert.equal(report.lines.other, 0)
    assert.equal(report.counts.get('workerHttp.forget.200'), 1)
    const { verdict, why, text } = watch.render(report)
    // Nothing in them is about what qwen.ai did — and two things are not the norm, said so: a profile that stayed
    // on the disk, and a mark that could not be read. Every count by its name, as the listing under "accounts
    // forgotten" shows it.
    assert.equal(verdict, 'LOOK')
    assert.deepEqual(why, [
        '2 forgotten account(s): the browser profile could not be removed (left 1, not removed 1, left after the pause 1, not removed after the pause 1)',
        '1 mark(s) of a deletion put off could not be read'
    ])
    assert.match(text, /accounts forgotten: what became of their browser profiles\n {4}absent {2}1\n {4}afterThePause\.deleted {2}1/)
    assert.match(text, / {4}deferred {2}3\n {4}deleted {2}2\n {4}kept {2}2\n/)
    // The report says counts, never what a line said.
    assert.doesNotMatch(text, /\d+ sessions\)|still running|EBUSY|profile (deleted|left|kept|absent|deferred|not removed) /)
    // Each said by itself, by its names; and a feed cut between the two lines of a failed removal says it too.
    const complaintsOf = said => watch.complaints(watch.summarize(said.map(line => `${at(5)} ${line}`)))
    assert.deepEqual(complaintsOf(['forget profile not removed (EBUSY)', 'forget session, page, profile left (1 sessions)']),
        ['1 forgotten account(s): the browser profile could not be removed (left 1, not removed 1)'])
    assert.deepEqual(complaintsOf(['forget profile not removed after the pause (EPERM)']),
        ['1 forgotten account(s): the browser profile could not be removed (not removed after the pause 1)'])
    assert.deepEqual(complaintsOf(['forget a mark could not be read: its profile stays as it is']),
        ['1 mark(s) of a deletion put off could not be read'])
    // The lines that are the norm keep the verdict they had as "other" lines: nothing to judge — a mark that
    // names no profile of its own is left alone on purpose.
    const norm = watch.summarize(lines.filter(line => !/profile not removed|profile left|could not be read/.test(line)))
    assert.equal(norm.counts.get('forget.mark.leftAlone'), 1)
    assert.deepEqual(watch.complaints(norm), [])
    assert.equal(watch.render(norm).verdict, 'NOTHING TO JUDGE')
    // A shape it does not know is said as such.
    for (const line of ['forget something else entirely', 'forget profile exploded after the pause (1 sessions)', 'forget session, page, profile gone (1 sessions)']) {
        const unknown = watch.summarize([`${at(5)} ${line}`])
        assert.equal(unknown.counts.get('unparsed.worker'), 1, line)
        assert.deepEqual(watch.complaints(unknown), ['1 line(s) of a shape this tool does not know'], line)
    }
})

test('the app’s word that a forgotten account’s profile goes after a pause is counted, and is nothing to judge (Qwen2API-t8s)', () => {
    // src/utils/account.js, FORGET_PROFILE_NOTE: of the three notes only the pause is the counter's.
    const forgot = note => said(MOMENT, 'INFO', 'ACCOUNT', `📝 signin-worker 已忘掉账户 gone@example.invalid（会话已清除，页面已关闭${note}）`)
    const report = watch.summarize([
        forgot('，浏览器配置稍后删除'), forgot('，浏览器配置稍后删除'),
        forgot('，浏览器配置已删除'), forgot('，浏览器配置没能删除'), forgot('')
    ])
    assert.equal(report.counts.get('app.forgetProfileDeferred'), 2)
    assert.equal(report.lines.app, 5)
    noUnknown(report)
    const { verdict, text } = watch.render(report)
    assert.equal(verdict, 'NOTHING TO JUDGE')
    assert.match(text, /forgetProfileDeferred {2}2/)
    assert.doesNotMatch(text, /example\.invalid|浏览器配置/)
})

test('a 503 on the head of a stream is named and said as a 502 is', () => {
    // `egress-stream … -> <status>`: what qwen.ai answered the call of completions, on the worker's line.
    for (const status of [502, 503]) {
        const report = watch.summarize([
            `${at(5)} egress-stream ${COMPLETIONS} -> ${status} (172147 ms, 3/20 pages)`,
            `${at(5)} egress-stream ${COMPLETIONS} end (172200 ms)`
        ])
        assert.equal(report.counts.get(`stream.head.${status}`), 1)
        assert.equal(report.counts.get('stream.head.200'), undefined)
        assert.equal(watch.render(report).verdict, 'LOOK')
        assert.deepEqual(watch.complaints(report), [`stream.head.${status}: 1`])
    }
})
