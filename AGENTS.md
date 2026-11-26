# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
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
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
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
