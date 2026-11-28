# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge, and keep the agent's own persistent memory (MEMORY.md) as well — the owner's rule for this repository, see "two exceptions" below

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

## This project — two exceptions to the block above

The block above is written by `bd` (`bd init`, and a later regeneration would
write it again), so its original wording can come back. Two of its lines do
not hold in this repository — the owner's decisions of 2026-11-25:

1. **Never run `bd dolt push` here.** It has failed since 2026-06-19: the
   tracker's remote copy is months out of date, and the local database is the
   only current one. Nothing pushes beads data to a remote from this project —
   not the session close, whatever `bd onboard`, `bd init` or `bd prime` may
   advise. A session is closed with `git pull --rebase` and `git push` alone.
   bd memory: `bd-dolt-push-broken`.
2. **Keep both kinds of memory.** `bd remember` for what belongs to the
   project, and the agent's own persistent memory (`MEMORY.md`) where it has
   one: the block's "do NOT use MEMORY.md files" does not apply. Where the two
   disagree, correct both.

Should the block be regenerated, make the same two changes inside it again —
drop the `bd dolt push` step of the session close, replace the MEMORY.md ban
with rule 2 — and leave this section as it is. Then take off what was appended
at the end of the file (`<!-- BEGIN BEADS CODEX SETUP … -->` up to
`<!-- END BEADS CODEX SETUP -->`: the same ban in other words), and see that
"Session Close" below still names the protocol's steps as they are numbered
now. `tests/agents-instructions.test.js` fails the gate while any of this is
missing.

What regeneration does (checked on a copy, 2026-11-27, bd 1.3.1): `bd init` on
an initialized repository refuses and touches nothing; `bd init --reinit-local`
rewrites the block to the current format — both edits inside it are lost, the
protocol's steps are renumbered, a `BEADS CODEX SETUP` block with the same
MEMORY.md ban in other words is appended at the end of the file, and bd
commits on its own — while everything outside the block survives: the top of
the file and every section below it, these two sections included. `bd setup
codex`, `bd setup claude`, `bd onboard` and `bd prime` change nothing in the
file; `bd onboard` and `bd init` still advise `bd dolt push` on their output.

## The test gate

`tools/test-gate.js` is the whole-suite gate (`npm test`): every file in
`tests/` runs in its own node process, and the sum of the per-file summaries
is checked against `tests/expected-counts.json`. Run it in a container built
from the recipe kept here — `tools/gate-image/` — on the Node major the image
is for:

- `tools/gate-image/Dockerfile` — `node:24-slim` + openssl + git: the runtime
  of CI's `regression` job (Linux, Node 24), so the result matches CI's.
- `tools/gate-image/Dockerfile.node20` — `node:20-slim` + openssl + git: the
  runtime of the sign-in worker's production image (`signin-worker/Dockerfile`).

openssl is for `tests/v2-lab-sessions.test.js`, which issues a self-signed
certificate; git for `tests/release-workflow.test.js`, which makes a scratch
repository (and skips itself, saying so, where there is none).

From Git Bash on Windows every `docker run` below needs `MSYS_NO_PATHCONV=1` —
without it the `/work` and `/out` of a mount option are rewritten into Windows
paths — and `<worktree>` is a Windows path, as `C:/temp/gate-out` is. The
builds carry no such path; the flag does no harm there:

```bash
MSYS_NO_PATHCONV=1 docker build -t qwen2api-gate-node24 tools/gate-image
MSYS_NO_PATHCONV=1 docker build -t qwen2api-gate-node20 -f tools/gate-image/Dockerfile.node20 tools/gate-image
```

The gate on a copy of the tree (the working tree can be edited while it runs;
`node_modules` from `bun install` on Windows work in the container as they
are). With `--bless` the baseline is recorded from three clean attempts and
copied out; the control run after it must print `TEST GATE: PASS`:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "<worktree>:/work:ro" -v "C:/temp/gate-out:/out" \
  -e API_KEY=ci-test-key -e DATA_SAVE_MODE=none -e ACCOUNTS= -e ENABLE_CLI=false \
  -e ENABLE_FILE_LOG=false -e CACHE_MODE=default -e SEARCH_INFO_MODE=text \
  -e TEST_GATE_TIMEOUT_MS=900000 \
  qwen2api-gate-node24 bash -c 'mkdir -p /src && cp -r /work/. /src/ && cd /src \
    && node tools/test-gate.js --bless && cp tests/expected-counts.json /out/ \
    && node tools/test-gate.js'
```

Drop the `--bless && cp … &&` part for a plain run. The variables are the ones
CI's `regression` job sets (`TEST_GATE_TIMEOUT_MS` is wider here: one attempt
takes minutes on a loaded machine). `--bless` stops at an unclean attempt and
says that `tests/expected-counts.json` was not updated.

Bless after adding or removing a test — or the next `npm test` fails: with
`BASELINE_STALE` after an addition, with `SHORT_RUN` after a removal. Commit
the blessed `tests/expected-counts.json` on its own
(`test(gate): bless N tests / M suites (...)`).

The manual cross-check — the same per-file sum the gate computes, run inside
either gate image at the root of a tree with `node_modules`:

```bash
for f in tests/*.test.js; do node --test --test-isolation=none --test-force-exit "$f"; done | grep -aE '^. tests [0-9]+$' | awk '{s+=$3}END{print s}'
```

Keep the `-a` on that grep: it is load-bearing — `tool-prompt.test.js` emits
bytes that make grep call the stream binary, and without `-a` its whole summary
line (133 tests) is silently dropped from the sum.

On Node 20 the gate script itself does not run (`--test-isolation` needs
Node 22). The worker's own test files are run there one process per file by
`tools/gate-image/run-worker-tests.js` — the list CI's `worker-node20` job
runs — on both Node majors with one command:

```bash
for image in qwen2api-gate-node24 qwen2api-gate-node20; do
  MSYS_NO_PATHCONV=1 docker run --rm -v "<worktree>:/work:ro" -w /work "$image" \
    node tools/gate-image/run-worker-tests.js
done
```

It compares no count: the number of generated tests varies with the Node
version. A red run is a failed, cancelled, skipped or todo test, a file that
ran no test, a crash or a hang past `WORKER_TESTS_TIMEOUT_MS` (CI gives a file
150 s), or a file that reported no summary.

## Session Close: Leave Nothing Unsaved

Adds to step 1 ("File issues for remaining work") and step 7 ("Hand off") of
the Session Completion protocol above. It applies whenever a session is being
closed: the user asks to close or end it, or the work is declared done.

**During the session, record as you go.** A finding that bears on another task
goes into that task's notes at once — the next session reads `bd show <id>`,
never the last report.

**Before the final report, run the tails review.** Go back over the whole
session and collect everything that was noticed, thought or decided, but not
saved:

1. **Ideas and improvements** — "it would be better if …", including the ones
   judged not worth doing now.
2. **Bugs and defects** — in code, docs, CI, tooling, infrastructure — that
   were seen and not fixed.
3. **Secondary tasks and loose ends** — what came up and was left undone;
   unverified cases and untested paths ("not checked live", "one observation").
4. **Deliberate omissions** — every "I decided not to do X", with the reason.
   These are the first to vanish.
5. **Comments on other open tasks** — anything that changes another task's
   scope, risk, plan or priority belongs in that task's notes.
6. **Volatile artifacts** — scripts, recipes and workarounds that live only in
   a temp directory or on a server: say where they are, or propose moving them
   into the repository.

Ask the owner's question in so many words: *what did I notice, decide not to
do, or leave unverified that is not in beads yet?*

**Then save every item in its place:**

- It bears on another open task → that task's notes:
  `bd update <id> --append-notes "$(cat file)"`.
- It is work of its own → a new issue:
  `bd create --title "$(cat title.txt)" --type task --priority 3 --body-file body.md --silent`
  (`--type bug` for a defect; the command prints the id).
- It is small, and there are several → one checklist issue, an item per line.
- It is a fact about the environment or the tooling → bd memory:
  `bd remember "$(cat file)" --key <slug>`, and the agent's persistent memory
  where it has one.
- It changes the scope or the design of the current task → its notes or design
  field, the earlier wording kept.

Priorities are preliminary: P3 for what matters soon, P4 for the rest; the
owner sets them and closes. Check `bd list` before filing, and do not file
twice. Write bodies through files. Say what is fact and what is hypothesis.
The review files and records; it does not take up the work itself — that
belongs to a new session with its own prompt.

**In the final report**, list what was filed, by id, and what was left as an
observation on purpose, with the reason. The owner closes the session trusting
that nothing stayed only in the agent's head.
