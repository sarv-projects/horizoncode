# Reliability remediation — final state, 2026-10-30

Everything here was measured on this machine. Command used for every product run:
`bash scripts/e2e/py-task.sh <task>` (API lane) and
`bash scripts/e2e/py-task-tui.sh <task>` (real TUI lane, no HTTP).

## 1. The number that matters

| run | before today | after today |
| --- | --- | --- |
| `retrykit`, API lane | 19 tool calls · **10 errors (47 % success)** · 226.5 s · 4 files / 438 LOC | 13 calls · **0 errors (100 %)** · **107.6 s** · 6 files / 474 LOC |
| `retrykit`, TUI lane | not runnable (`--yolo` refused on a fresh session) | 163 s · 6 files · own suite `Ran 30 tests … OK` · independent check **24 / 25** |
| `auditlog`, API lane | 31 calls / 8 errors, then 35 / 6 | 47 calls / 12 errors → **22 calls / 3 errors** after the tool-description mitigation · 8 files / 881 LOC |
| `auditlog`, TUI lane | 21 / 22 then 20 / 22 (no UI either time) | 352 s · 9 files / 1 157 LOC · independent check **22 / 22 → VERIFIED** |

The clean result is the retrykit lane: **zero failed tool calls**, and 2.1× faster
wall clock because the model stopped spending a third of its budget rediscovering
that a directory did not exist and decoding an opaque error tag.

The auditlog API lane is the honest counter-example: 3 failures remain, all one
defect (§3, A3-same-file). Before the tool-description mitigation the same task
produced 12 failures out of 47 calls; stating the constraint in `tool/edit.txt`
took it to 3 out of 22. That is a prompt-level mitigation, not a fix — the kernel
still refuses a staged preimage, the model just stops asking for one as often.

## 2. What was fixed

| id | defect | fix | proof |
| --- | --- | --- | --- |
| A1 | `files.write` denied `path_unavailable_or_unsafe` whenever the parent directory did not exist — 9× across 3 runs, every first write into a fresh tree | `kernel/src/effect_host.rs`: `inspect_write_target` returns `Present`/`Absent`/`MissingParent`, so a missing chain is recoverable instead of a denial; the effect creates the chain with `mkdirat` walked component-by-component off the workspace root fd (never a path string), mode pinned after umask | `cargo test --test effect_direct_write` → **5/5**, including nested `a/b/c/file.txt` at mode `0o755`, overwrite preserving `existed: true`, and `../../escape.txt` still denied |
| A2 | `bash` failed with the bare tag `Pty.InvalidInputError` and no reason — 6 of 19 calls | `packages/core/src/pty.ts`: every `Pty` typed error now puts its `reason` in `message` (the generated `toString` already prefixes the tag, so nothing is duplicated). `packages/horizoncode/src/tool/shell.ts` validates the admitted `terminal.run` set and says exactly which of `command`/`cwd`/`timeoutMs` is missing | module loads clean under bun; failing shapes now produce an actionable sentence instead of a tag |
| A3 | multi-call `edit` batches denied `guarded operation set or lease changed` — 28× | `packages/horizoncode/src/session/tool-batch.ts`: one lease per batch (`sharedBatchLease`) bound to the whole operation set, normalized `{command,cwd,timeoutMs}` execution for every admission status (`resolveMemberExecution`), and batch-scoped `pendingContent` so member 2 prepares against member 1's output | new `test/session/tool-batch-batch-lease.test.ts`: **0 pass / 3 fail before → 3 pass / 0 fail after** (31 assertions). The `guarded operation set or lease changed` string no longer appears in any run |
| A3b | same-file two edits in ONE message still refused — kernel validates each patch preimage against live bytes at plan time (`stale_preimage`), 10 of the 12 remaining auditlog failures | mitigation, not a fix: `tool/edit.txt` now states the constraint explicitly ("ONE EDIT PER FILE PER MESSAGE"), so the model splits the work instead of discovering the refusal | measured: same task went 47 calls / 12 errors → **22 calls / 3 errors**; all three survivors are still `stale_preimage` |
| CMD-1 | a command's frontmatter `model:` beat the caller's model; when unresolvable the turn died as an opaque HTTP 500 | `session/prompt.ts` treats the pin as a preference and falls through to agent → caller → session model | `/issues` and `/translate` went **500 → 200** (`slash-probe-one.sh`); main prompt path unregressed (retrykit 11 calls / 0 errors) |
| TUI-1 | `--yolo` was refused on a fresh TUI: *"permission mode … was not applied — no direct Session exists yet; choose it in /permissions after the first prompt"*, and `/permissions` does not exist in this build | `packages/horizoncode/src/cli/cmd/tui.ts` creates the Session up front and applies the posture to it before handing control to the UI — exactly what `cli/cmd/run.ts:544-559` already did | TUI stderr now prints `permission mode: danger-full-access · never (yolo)` with no caveat; 4 successful autonomous TUI runs |
| TUI-2 | closing the terminal (or detaching tmux) crashed the TUI with `EIO: i/o error, write` at `packages/tui/src/app.tsx:364`, replacing the exit banner with a stack trace | teardown writes go through `safeWrite()`: skip a destroyed/non-writable stream, swallow the throw, attach a one-time `error` listener | no `EIO` in the last four TUI runs |
| CLI-1 | `horizoncode --help` wrote everything to stderr, so `horizoncode --help \| head` printed nothing | `packages/horizoncode/src/index.ts`: explicit help goes to stdout, branding stays on stderr | `--help` → 60 lines on stdout, 6 on stderr, rc 0 |
| CLI-2 | `horizoncode`/`hzcode` exited with *"could not resolve a compatible Linux CLI binary"* in any checkout without a packaged platform binary | `packages/horizoncode/bin/opencode` falls back to the TypeScript entrypoint under bun, with a one-line notice on stderr | `./packages/horizoncode/bin/horizoncode --version` → `local` |

## 3. Error taxonomy after the fixes

| task | remaining failures | cause |
| --- | --- | --- |
| retrykit | **0** | — |
| auditlog (API) | 3 × `stale_preimage` (was 10 before the mitigation) | same-file multi-edit in one message; kernel-side deferred preimage validation not implemented |
| auditlog (API) | 2 × `oldString not found` | the model quoted text it had not read; correct refusal |

## 4. TUI lane — what it took, and what it proves

`scripts/e2e/py-task-tui.sh` drives the real interactive TUI through a PTY
(detached tmux), pastes the whole prompt as one bracketed paste, waits for the
pane to go idle, and makes **no HTTP requests at all** — the TUI owns its server
in-process. Posture evidence is read from the TUI's own stderr.

Six harness problems had to be solved before a run was possible, and all of them
are real product facts worth knowing:

1. Bun resolves `tsconfig` from the current directory, so the TUI must be launched
   from `packages/horizoncode` or it dies with `Cannot find package 'react'`.
2. Kernel assets must reach the TUI **worker** process: `globalThis` assignments do
   not cross the Worker boundary, so `OPENCODE_HOST_KERNEL_ASSET`/`…_MANIFEST` go
   in as environment variables.
3. The TUI repaints only on input — a boot driver must nudge with resize/Escape
   until the footer appears, and a blank first frame needs a relaunch (1 in 4 runs).
4. Once a Session is pre-created, "Ask anything" is not a readiness marker; the
   footer hint `ctrl+p commands` is.
5. Multi-line pastes collapse into `[Pasted ~N lines]`, so prompt verification must
   accept the chip.
6. Terminal effects need the delegated cgroup scope (`hz_ensure_scope`), otherwise
   they fail with "terminal containment could not be bound".

## 5. Slash commands — all 101 probed

The important discovery is architectural: **slash parsing is client-side**. A text
part `/name` sent to `POST /session/:id/message` never runs a command — it is
answered conversationally for every single one (92 `IGNORED` on that path). The TUI
parses the leading `/` and calls `POST /session/:id/command`. Earlier "21 of 22
unproven" was really "we were watching the wrong endpoint".

Full sweep, one dispatch per command (`reports/slash-commands-2026-10-29.md`):

| outcome | count |
| --- | --- |
| WORKS | **84** |
| ERROR | 5 |
| TIMEOUT | 12 (11 of them `dispatched_slow` — template expanded, turn still running at the 120 s probe budget) |
| IGNORED / UNPROBED | 0 / 0 |
| **commands probed** | **101** |

- `/init` and `/review` — the only two shipped templates — both complete.
- `commit`, `xlsx`, `Command Development` → 503 *"Shell execution is unavailable
  until terminal.run is mediated by Rust Guard and ExecutionHost."* Architectural,
  not a bug: those templates run `!`…`` blocks that need a mediated shell.
- `issues`, `translate` → 500 `UnknownError`; `changelog` → timeout. All three pin
  `model: opencode/…` in frontmatter, and the pin won precedence over the caller's
  model.
- Two smaller defects: an unknown command returns **500 `UnknownError`** instead of
  404, and **7 registered names contain spaces** (e.g. `Agent Development`), which
  no slash client can type.

### Command model pins (fixed, with a caveat)

A command's frontmatter `model:` was treated as a requirement. When it could not be
resolved the whole turn died with an opaque HTTP 500. `packages/horizoncode/src/session/prompt.ts`
now treats it as a preference: it probes the pin and falls through to the command's
agent model, then the caller's model, then the session model.

Measured with `scripts/e2e/slash-probe-one.sh issues translate`:
**500 → 200**, both commands now complete a turn. Caveat: in this isolated
environment they still fail at the provider layer (`opencode` resolves to a local
gateway that is not running), so the command is honest about a provider error
instead of the server crashing. That is a configuration gap, not a code gap.

Regression check after the change: retrykit API lane **11 calls / 0 errors**, 22
tests green — the main prompt path is unaffected.

## 6. Still open

| item | state |
| --- | --- |
| same-file multi-edit preimage | kernel must validate a staged preimage inside the lease, otherwise `stale_preimage` returns. Mitigated by the tool description, not fixed |
| `/commit`, `/xlsx`, `Command Development` | 503 by design — they need `terminal.run` mediated by Guard |
| `/issues`, `/translate` | no longer 500; they now surface an honest provider error because the pinned `opencode` provider is unreachable in this environment |
| unknown command → 500 | should be 404 |
| 7 commands with spaces in their names | unreachable from a slash client |
| subagent lane | still dead by flag (`DIRECT_CHILD_TURN_RPC_ENABLED = false`) |
| completion gate | still absent — `completeDirectTurn(resultDigest)` accepts an arbitrary string |
| coverage ledger | designed in `docs/reliability/2026-10-29-reliability-program.md`, not built |
| V1 wire tracker | 0 rows `Done`; header counts now derivable from the rows |
