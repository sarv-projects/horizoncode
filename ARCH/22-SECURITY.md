# 22 — Security: consolidated threat model

## Purpose

One document that states, for the whole binary, **what must never happen**, **who is
trying to make it happen**, **which boundary stops it**, and **what is still true
after the boundary stops it**. Every other module document describes a component;
this one describes the attack surface those components collectively expose, so that a
reviewer can ask "what is the threat here?" and get a falsifiable answer.

It is a threat model, not a promise. Each row names an **existing control** by
component so it is clear what is already enforced, a **residual risk** so nothing is
over-claimed, and a **mitigation to implement** so the gap is tracked. Where a risk
cannot be closed at all, it is recorded in the residual-risk register rather than
quietly mitigated.

Posture is **fail closed** throughout: an unknown permission, an unmaterializable
confinement profile, an unreadable policy layer, an unverifiable audit anchor, an
unpinned extension, and an unclassifiable failure are all *refusals*, never silent
success (`ARCH/01-VISION.md` §3, `DEC-005`, `DEC-012`, `DEC-018`).

## Scope

**In scope.** The entire shipped binary and everything it causes to happen: the
three surfaces, the control plane, the trust layer, persistence, provider traffic,
the native tool plane, subprocess execution, egress, extensions (skills, plugins,
hooks, MCP servers), peer agents, and the local on-disk state a run leaves behind.

**Governing posture rules** (already decided elsewhere; restated here only as the
security frame):

1. **One decider** — exactly one component returns `allow | ask | deny` (`CMP-guard`).
2. **One egress path** — all outbound network is mediated and authorized (`CMP-sandbox`
   network policy; `CMP-tools` fetch tools; `CMP-provider`; `CMP-mcp`).
3. **One governed effect path** — authorize → confine → execute → record. No
   privileged shortcut exists anywhere, for any caller (`ARCH/03` §4.3).
4. **Content is data** — repository text, fetched pages, tool output, skill bodies,
   peer responses, and instruction files are untrusted and carry no authority
   (`REQ-SEC-002`).
5. **Custody** — credential values exist only inside `CMP-secrets` and are injected
   at call time; they are never read into prompts, logs, telemetry, or audit
   (`REQ-PROV-004`, `REQ-AUDIT-003`).
6. **Discovery is not trust** — nothing external is enabled, executed, or believed
   until it is explicitly enabled and pinned (`DEC-018`).

### Assets

| ID | Asset | Why it matters | Primary owner |
|---|---|---|---|
| `AS-1` | **User source and workspace data** | The user's code; irreplaceable | `CMP-session`, `CMP-sandbox` |
| `AS-2` | **Credentials and tokens** (model providers, OAuth, registry tokens, SSH/VCS keys) | Compromise is silent, lateral, and unrecoverable | `CMP-secrets` |
| `AS-3` | **Policy and configuration** (guard rules, sandbox profiles, config layers) | Rewriting policy converts every allowlist into an allow-all | `CMP-guard`, `CMP-config` |
| `AS-4` | **Execution authority** (the process's own OS privileges, confinement profile) | The thing every other control is scoped by | `CMP-sandbox` |
| `AS-5` | **Audit chain and its anchors** | The only verifiable record of what happened | `CMP-audit` |
| `AS-6` | **Session/event history and task graph** | Long-horizon work state; losing or forging it loses the run | `CMP-session` |
| `AS-7` | **Budget and quota** (tokens, cost, wall-clock, egress) | Directly convertible to money by an adversary | `CMP-runner`, `CMP-orch`, `CMP-provider` |
| `AS-8` | **Host integrity outside the workspace** (other repositories, home directory, OS configuration) | Blast radius beyond the task | `CMP-sandbox` |
| `AS-9` | **User attention / approval channel** | An approval the user cannot interpret is a rubber stamp | `CMP-tui`, `CMP-headless`, `CMP-acp` |
| `AS-10` | **Third-party trust surface** (skills, plugins, hooks, MCP servers, peer agents) | Extension code is the cheapest way in | `CMP-config`, `CMP-mcp`, `CMP-orch` |

### What must never happen

Each of these is a **forbidden outcome** (`FO-*`). A violation is a defect, not a
tuning problem. None of them is acceptable in a degraded, offline, yolo, headless,
or "just this once" mode.

| ID | Forbidden outcome |
|---|---|
| `FO-1` | An effect executes **without** a `CMP-guard` decision, or executes after a `deny`. |
| `FO-2` | An effect executes outside the resolved confinement profile, or unconfined without an explicit audited user action. |
| `FO-3` | A filesystem effect lands outside the granted roots, or a denied path is read (directly or after relocation). |
| `FO-4` | A command is built by string-concatenating model- or file-supplied content into a shell. |
| `FO-5` | A credential value appears in a prompt, tool input/output, error, log, TUI frame, analytics row, or audit entry. |
| `FO-6` | External content causes an action to be taken as an *instruction* rather than as data. |
| `FO-7` | A security-relevant effect is committed without a durable, chained audit entry. |
| `FO-8` | Audit history is added to, removed, reordered, truncated, or modified without detection **given a trusted anchor**. |
| `FO-9` | A child, sub-agent, or peer holds authority its parent does not hold. |
| `FO-10` | An unpinned, undiscovered-provenance, or non-explicitly-enabled extension is loaded, executed, or granted authority. |
| `FO-11` | A budget ceiling is exceeded without a fail-closed stop, or a ceiling is raised by a value the model supplied. |
| `FO-12` | An outbound request reaches a target the policy did not authorize, including via DNS, redirect, or an extension process. |
| `FO-13` | Project-scoped (untrusted) configuration can widen authority, enable unconfined/full access, or change the fail-closed unmatched effect to allow. |
| `FO-14` | A stored rule ("always allow") differs from the pattern shown to the user at confirmation time. |
| `FO-15` | A state, policy, or config path is followed through a symlink/junction to retarget it outside its expected root. |

### Trust boundaries

A boundary is a place where the **assurance level changes**. Anything that moves
toward more authority across a boundary must be *authorized*, not merely *accepted*.
The diagram shows the primary path; `TB-6`…`TB-8` are cross-cutting and are defined in
the table that follows.

```
   ┌─ TB-0 ────────────────────────────────────────────────────────────────┐
   │ USER  ── typed prompt / approval reply / explicit enable              │
   └───────────────────────────────┬───────────────────────────────────────┘
                                   │  the only channel that may grant authority
   ┌─ TB-1 ────────────────────────▼───────────────────────────────────────┐
   │ CONTROL PLANE  CMP-runner · CMP-tools · CMP-orch · CMP-context        │
   │  decides intent, assembles context, schedules effects                 │
   └───────────────────────────────┬───────────────────────────────────────┘
                                   │  authorization (CMP-guard) + confinement (CMP-sandbox)
   ┌─ TB-2 ────────────────────────▼───────────────────────────────────────┐
   │ TRUST LAYER  CMP-guard · CMP-sandbox · CMP-secrets · CMP-audit       │
   └───────┬───────────────────────────────────────┬───────────────────────┘
           │ effect                               │ evidence
   ┌─ TB-3 ─▼──────────────┐            ┌─ TB-5 ─▼───────────────────────┐
   │ HOST / OS primitives  │            │ PERSISTENCE  CMP-session        │
   │ fs · process · net    │            │ · CMP-audit · CMP-analytics     │
   └───────────────────────┘            └─────────────────────────────────┘
   ┌─ TB-4 ────────────────────────────────────────────────────────────────┐
   │ UNTRUSTED SOURCES (data only, never authority)                        │
   │ repository text · fetched pages · tool output · MCP responses ·       │
   │ skill/plugin bodies · instruction files · sub-agent receipts ·        │
   │ peer-agent frames · catalog data · external peer processes            │
   └───────────────────────────────────────────────────────────────────────┘
```

| ID | Boundary | Crossing rule | Enforced by |
|---|---|---|---|
| `TB-0` | user → control plane | Only a user act may grant or widen authority; a model proposal is not a user act | `CMP-guard`, `CMP-tui`, `CMP-headless`, `CMP-acp` |
| `TB-1` | control plane → trust layer | Every effectful capability call presents a resource set and receives exactly one decision | `CMP-tools`, `CMP-orch`, `CMP-acp`, `CMP-mcp` |
| `TB-2` | trust layer → host | The kernel, not the process, bounds what is reachable; an authorization is not a grant of reach | `CMP-sandbox` (all tiers), `ARCH/13` |
| `TB-3` | host → external network | One mediated egress; host/port/protocol authorized **after** resolution and re-authorized per redirect hop | `CMP-sandbox` network policy, `CMP-guard` `net.connect` |
| `TB-4` | untrusted source → context | Content enters the model request **labeled and framed as data**; it cannot create a rule, a ticket, a grant, or a decision | `CMP-context`, `CMP-tools` framing, `CMP-orch` receipt intake |
| `TB-5` | effect → evidence | A security-relevant effect is not *complete* until its audit entry is durably chained | `CMP-audit`, `CMP-session`, `CMP-analytics` (`DEC-020`) |
| `TB-6` | in-process → external extension process | An extension runs confined, with no ambient network **at the tier's declared `network_guarantee_level`** and workspace-scoped writes; its effects pass the same guard | `CMP-sandbox`, `CMP-config`, `CMP-mcp` |
| `TB-7` | HorizonCode → peer agent | Authority is *never* delegated across the ACP boundary; only proposals cross, and each is re-authorized locally | `CMP-acp` client mode, `CMP-guard`, `CMP-orch` |
| `TB-8` | local state → future run | Persisted content (config, logs, bundles, catalog cache) is re-validated before it can influence behavior | `CMP-config`, `CMP-session`, `CMP-audit`, `CMP-provider` |

### Adversaries

| ID | Adversary | Capability assumed | Primary goal |
|---|---|---|---|
| `AV-1` | **Malicious repository content** | Can place arbitrary bytes in any tracked or untracked file, plus arbitrary `AGENTS.md`/config/skill files, and instruct the user to run HorizonCode there | Steal credentials or host files by talking the agent into acting |
| `AV-2` | **Hostile web page** | Fully controls the text a fetch tool returns, including instruction-shaped text, redirects, and response headers | `FO-6`, then `FO-1`/`FO-3` via the agent |
| `AV-3` | **Compromised dependency / build script** | Runs inside the build or the toolchain, and can observe or alter produced artifacts | Poison the binary, the notices bundle, or the audit chain |
| `AV-4` | **Malicious MCP server or skill/plugin** | Is explicitly enabled by a user who believed it benign; can return arbitrary tool output, install, or run a process | Persistence, host read/write, egress, credential capture |
| `AV-5` | **Hostile peer agent in a multi-agent run** | Speaks the peer protocol, is user-installed, and can return crafted frames, unbounded streams, and deceptive permission requests | Escalate authority, borrow the user's approval, exfiltrate |
| `AV-6` | **Local unprivileged attacker** (a different unprivileged account/process on the same host) | Can read/write shared locations, plant files, and race the state directory | Tamper with evidence, poison the cache, retarget paths |
| `AV-7` | **Model misbehaviour or a manipulated provider** | The model can emit any tool call, argument, or text; a provider endpoint can return any bytes | `FO-1`…`FO-13` via the decision path |

Assumed **non**-adversaries: the OS user themselves (see the trust-boundary note in
§Out of scope), and a kernel with a correct, unpatched enforcement primitive.

## Threats / Strategy

### Cross-cutting strategy

1. **Authority is granted only at `TB-0`, only by a user act, only as an exact
   pattern.** Everything else is a proposal.
2. **Enforce below the decider.** The kernel is the boundary (`TB-2`); a
   `CMP-guard` allow is not reach. A confinement profile that cannot be applied is a
   refusal, not a warning.
3. **Fail closed on every uncertainty**: parse error, decision timeout, approval
   timeout, missing backend, unreadable rule layer, unpinned artifact, unverifiable
   anchor, oversized input, unknown protocol method.
4. **Refuse rather than narrow silently.** Every fallback that reduces capability
   surfaces the reduction; no silent downgrade.
5. **Contain, do not only detect.** Injection hygiene is a *containment* property
   (content cannot grant authority), not a claim that hostile text is reliably
   recognized.
6. **Record before trusting, record after acting.** Denials, refusals, backends
   removed, anchors missing, and quarantines are first-class entries.
7. **Static enforcement for structural claims.** Boundary properties that prose
   cannot hold (no second permission path, no unguarded effect, no direct network
   client above the adapter layer) are CI architecture gates, not review items.

### T-1 — Filesystem and tool plane (`CMP-tools`, `CMP-sandbox`, `CMP-session` client fs)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `F-01` | `AS-1`,`AS-8` | Relative traversal (`../../`) or an absolute path outside the workspace reaches host files | Separate `external_directory` floor rule in the guard with effect `ask`; `check_path`/`spawn`; deny globs; protected subpaths; workspace-scoped write **and read** roots | Guard resource patterns may be evaluated on a **non-canonical** path, and the tool-plane bash argument scan is **advisory extraction only** — the hard control is spawn-time containment (`DEC-024`, `ARCH/10`) | Canonicalize and contain at the **enforcement** layer for every fs operation; reject absolute paths outside granted roots at spawn; scope reads to granted roots on every tier; assert the pattern grammar parity between `CMP-guard` and `CMP-sandbox` |
| `F-02` | `AS-1`,`AS-3` | A symlink/junction inside a granted root points at a denied or foreign path | Canonicalization before policy; deny globs enforced at the kernel; refuse a symlinked policy/config path | Check-then-open window: the link can be swapped between validation and use | Re-canonicalize **at use**; deny on mismatch with a typed error; no policy decision is ever made on a non-canonical path; use handle-relative validation where the platform allows |
| `F-03` | `AS-1`,`AS-6` | TOCTOU between the conflict check and the write: the file changes after re-read/hash/compare | One governed write path: lease → re-read → digest compare → atomic rename, else typed conflict | The compare is advisory against an **external** writer that does not hold the lease | Make the governed write path the only mutation route; re-validate digest at the rename boundary; treat a lease held by another principal as a hard refusal |
| `F-04` | `AS-3` | A write grant is used to rewrite VCS hooks or agent-owned config inside a writable root | Protected subpaths stay read-only inside any writable root (`ARCH/13`) | Protection depends on correct root identification; a re-pointed workspace root changes the protected set | Pin and re-verify the workspace root and protected set at session start and refuse on change; audit protected-subpath violations distinctly |
| `F-05` | `AS-1` | Huge file read/write to exhaust memory or disk | Output bounding, per-transport byte ceilings, managed spill, retention pruning | In-process reads may bypass the model-facing bound | Stream with a hard cap; reject oversize **before** open; cap total session bytes with a typed failure |
| `F-06` | `AS-3`,`AS-8` | A relative or symlinked `--dir`/workspace id re-points the run at a different root | Workspace identity re-resolved before any resumed write; typed `NotFound` + re-point guidance | First-run resolution trusts the current directory | Canonicalize the root at startup, refuse a root that is a link into an unexpected location, and record the resolved root in the session + audit |

### T-2 — Shell and process execution (`CMP-tools` `bash`, `CMP-sandbox` `spawn`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `E-01` | `AS-4` | Command/argument injection by string-concatenating model- or file-supplied text into a shell | Argv-based spawn; policy evaluated on a command token prefix | Any future convenience wrapper that builds a shell string reintroduces `FO-4` | Static gate: no shell-string construction on the tool path; a lint/CI check plus a test that a crafted argument containing shell metacharacters is passed through inertly; reject NUL/newline in an argument |
| `E-02` | `AS-2` | Environment injection: an attacker-supplied env value overrides a required one, or the host env leaks ambient credentials | Child env filtered; secret fields are references only; header/query/body redaction | Host environment may already contain tokens (VCS/net helpers) that a child would inherit | Explicit child-env allowlist; never forward HorizonCode-resolved credential material; record the child's env **shape** (names) in audit, never values |
| `E-03` | `AS-1` | A child re-parses an argument as a shell command (interpreter shim, `sh -c`, a wrapper script) and reaches a denied path | Kernel-level deny globs apply to the whole process tree, not only the direct child; the sandbox is the sole reach authority at spawn (`DEC-024`, `REQ-SEC-025`) | `exec.run` pattern rules are prefix-shaped; they are not a semantic guarantee about what a wrapper will do. A lexical argument scan **cannot** close this — a shell re-parses, so the scan is an extraction/escalation signal only | State explicitly that `exec.run` patterns match argv tokens, not interpreted semantics, and that `exec.run` carries no path-shaped resources; keep the catastrophic gate evaluated on the **resolved** argv; test a shim path that re-executes a denied target |
| `E-04` | `AS-4` | Escape via process inspection, VM sockets, `io_uring`, or an unfiltered syscall on a newer kernel | seccomp filter denying the escape-relevant syscall classes; empty capability set; `no_new_privs` | Newer kernels introduce syscalls not in an older filter set | Pin the required filter set per kernel range; **refuse** the effect when the set cannot be installed; a syscall-enumeration test per supported kernel |
| `E-05` | `AS-4`,`AS-7` | A hung or fork-exploding child outlives the wall-clock bound | Watchdog → interrupt/cancel; tree reaped; process/child limits | Descendants that detach from the process group survive | Re-parent tracking and group/cgroup/job kill; a per-effect process-count cap; a test that a double-forked grandchild is reaped |
| `E-06` | `AS-4` | Orphans persist after session teardown and are re-adopted by a later run | Reaping on cancel; stray reconciliation is an open item (`ARCH/13`) | Strays can retain workspace write access | Reconcile strays at startup and at teardown, record them in audit, and re-apply the profile of the owning session |

### T-3 — Egress and network (`CMP-tools` fetch tools, `CMP-provider`, `CMP-mcp` HTTP, `CMP-sandbox` network policy)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `N-01` | `AS-8`,`AS-2`,`AS-7` | SSRF to loopback, private, link-local, or reserved ranges, directly or by name | One mediated egress; `net.connect` rule on `host:port`+protocol; `network: none` by default | DNS answer can change between resolution and connect (rebinding) | **Resolve-then-check-then-connect-to-the-validated-address**; re-validate on every connection attempt; a name that resolves into a denied range is refused with a typed error |
| `N-02` | `AS-8` | Redirect (3xx) to a denied host, or a redirect chain that changes the host silently | Redirects are a fetch-tool concern; policy applies per request | An implementation may follow a redirect before re-authorizing | Cap redirect depth; **re-authorize each hop** against `net.connect`; surface the host change; never follow a cross-host redirect silently |
| `N-03` | `AS-8` | Scheme abuse (`file:`, `data:`, vendor-specific schemes) or a non-HTTP protocol on an allowed port | Per-protocol grant semantics | Adapters may accept more than one scheme | Explicit scheme allowlist per tool; an unknown scheme is a typed refusal, not a fallback |
| `N-04` | `AS-2` | Credential smuggled in a URL, query key, or `userinfo` | Redaction of userinfo, authorization headers, and secret-pattern keys; credentials only as references | A URL that already contains a token is *stored* before redaction in some code paths | Reject URLs containing `userinfo` outright; redact query keys matching the secret pattern set **before** the URL is persisted or logged; never log a full URL — normalized `host`/`host:port` only |
| `N-05` | `AS-7` | A malicious or broken MCP server returns an unbounded body, or paginates forever | Per-server timeout, visited-cursor set, hard page cap, dedupe | Response size is not obviously bounded on every method | Per-method response byte ceilings with streaming abort; a cap overrun is a typed error, never a partial read treated as complete |
| `N-06` | `AS-4`,`AS-8` | An extension opens its own socket, bypassing the single egress path | Extension processes run confined with network denied **to the level the tier declares** (`DEC-026`, `DEC-027`); one-egress rule | An in-process extension surface could reach a network primitive | Static sweep for direct network-client construction above the adapter layer; extension processes are always out-of-process and confined at the declared level; any in-process network use must go through the mediated path with a `net.connect` decision |
| `N-07` | `AS-7` | `Retry-After` abuse, redirect loops, or retry storms amplify load on a third party or an internal host | Bounded retries with jitter, cooldown, typed failure classification | Jitter source and cap are not fixed; a hostile server can still be polled | Bound total attempts and total elapsed time per logical request; observe rate-limit hints; record a retry storm as an audited anomaly |

### T-4 — Context assembly and prompt injection (`CMP-context`, `CMP-runner`, `CMP-tools` output, `CMP-orch` receipts)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `P-01` | `AS-1`,`AS-2`,`AS-4` | A fetched page contains instruction-shaped text that the model follows as a command | Content framed as untrusted, non-instructional data; consequential actions still require a decision | **A sufficiently persuasive payload can still influence model behavior.** We do not claim reliable detection | Containment, not detection: content cannot grant authority; provenance is carried with the item; an injection corpus test asserts the corpus produces **no unauthorized effect** (not that the text is flagged); user-visible provenance on fetched content |
| `P-02` | `AS-3` | Repository text — `AGENTS.md`, comments, READMEs, test fixtures, docstrings — asserts policy or approval | Instruction files are a typed source injected as data; project config may only narrow | A project file can still try to say "ignore your rules" | Project-scoped configuration is explicitly untrusted: it cannot set `unmatched: allow`, cannot enable unconfined/full access, cannot change guard mode to widen; schema-level rejection, not just evaluation-time filtering |
| `P-03` | `AS-3`,`AS-1` | A skill body or an MCP tool description carries instructions that request extra authority | Skill instructions injected as data; `allowed-tools` is an approval **hint**, never a sandbox or a grant | An activated skill can bias the plan toward a dangerous action | A skill cannot create a rule, ticket, or grant; activation re-resolves requirements and re-asks through the guard; keep the hint/grant separation asserted by test |
| `P-04` | `AS-1`,`AS-3` | A sub-agent receipt ("summary") contains instructions for the parent | Receipts are untrusted, schema-validated, size-capped, and scanned for instruction-shaped content | A flagged receipt could still be persuasive | A receipt never auto-executes; every resource named in a receipt is re-authorized by the parent through the normal path; a scanned-and-annotated receipt is visibly annotated |
| `P-05` | `AS-2` | Injected text asks the agent to read and transmit a credential file | Deny globs for secret-shaped paths enforced at the kernel; credential values are never materialized into context | A credential already in a non-denylisted file (e.g. a config with a literal token) is readable | Keep the deny-glob set an extend-only reviewed list with a documented threshold; a secret-scan preflight over changed files warns (and can be made to deny) without claiming to be exhaustive |
| `P-06` | `AS-3` | Poison the stable prompt prefix so a cached, reused prefix carries an injected instruction | Fixed assembly order; the cached prefix is not mutated mid-run; system sources are first-party-rendered | A new-build or explicit rebuild could admit a mutated source | Only first-party-rendered system content may occupy the stable prefix; any prefix-affecting change is a cache-bust event and is recorded; a prefix digest is stored with the session so drift is visible |
| `P-07` | `AS-6` | After compaction, a shadowed range is reintroduced as trusted context, or a tool call is split from its result | Checkpoint renders as untrusted background; tool-pair balancing; epoch pinning | A summary produced by the model can itself mis-attribute decisions | Summary is schema-bound; exact errors/paths are copied verbatim; a rejected/unbalanced span is not compacted; post-compaction retrieval probe is a release gate (`ARCH/23`) |

### T-5 — Secrets and observability surfaces (`CMP-secrets`, `CMP-provider`, `CMP-audit`, `CMP-analytics`, `CMP-tui`, `CMP-headless`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `S-01` | `AS-2` | A secret is placed in a prompt or context item | Use-style injection at call time; the broker never returns a value to caller code that assembles prompts | A new call site could ask for a value instead of a use | Type-level no-return secret API; a CI check that prompt-assembly code has no secret accessor; corpus scan of recorded transcripts |
| `S-02` | `AS-2` | A secret leaks through a `Debug`/error/panic path | Typed errors; no raw provider body; redaction pass; `missing_debug_implementations` lint | A panic message or a `tracing` field can bypass the redaction pass | No `Debug` on secret-bearing types; a redacting panic hook; an error-construction lint; test by forcing each error path with a canary secret |
| `S-03` | `AS-2`,`AS-5` | A secret reaches an audit entry or an analytics row | Redaction before chaining; entries carry refs/digests/bounded metadata, never prompt or completion text | External text that *echoes* a secret (a hostile tool or a provider error body) is persisted as ordinary content | Redaction runs over **all** persisted external text, not only known secret fields; a redaction failure refuses the entry rather than chaining it |
| `S-04` | `AS-2`,`AS-9` | A secret appears in the TUI (approval string, transcript, diff preview) | Redaction before display; approval metadata is non-secret context only | A raw diff or managed-output preview can contain a secret from the workspace | Canary run asserting no plaintext secret in any rendered frame; preview/spill paths are covered by the same redaction pass |
| `S-05` | `AS-2` | Secret exposure via core dump, child env, or a process listing | Child env allowlist | Core dumps and `/proc`-visible env are host-level concerns | Scrub env for children; disable core dumps for sandboxed children where the platform allows; document the residual host exposure |
| `S-06` | `AS-2` | An OAuth/registry token is inlined into config or a command line | Config holds references only; an inlined value is rejected at load; headers carry refs | Environment-variable references in committed project config can name a secret store path | Reject raw secret-looking values at load; keep reference expansion confined to the broker |
| `S-07` | `AS-2`,`AS-6` | Analytics export leaks content | Local-only by default; export is opt-in and sanitized; prompts/file contents excluded by default | Sanitizer is a deny-list | Canary-secret export test; the export path is a single chokepoint; sanitization is applied to the stream, not only the header |
| `S-08` | `AS-2` | A hostile extension exfiltrates what it already read | Confined processes; network off by default; guard-mediated effects | A plugin with a legitimately granted read can still read and then *encode* the value into its own output | Bound and scan extension output before it enters context; a plugin's declared scope is shown at enable time |

### T-6 — Guard, policy, and privilege (`CMP-guard`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `G-01` | `AS-3` | A decision is made on a non-canonical resource, so the matched rule is not the applied rule | Canonicalization requirement in the resource model | Enforcement depends on every caller canonicalizing | `CMP-guard` refuses a non-canonical resource with a typed error rather than guessing |
| `G-02` | `AS-3`,`FO-13` | Untrusted project config sets `unmatched: "allow"` or widens a ceiling | `unmatched` may never be `allow`; outer-scope deny is a non-overridable ceiling | Validation is only as good as the schema path | Schema-level rejection of `unmatched: "allow"` in every layer; test that a project layer cannot widen a global deny |
| `G-03` | `AS-4`,`AS-9` | "Always allow" persists a broader rule than the one shown | The exact `save[]` pattern is displayed pre-confirmation; "always" persists exactly those `{action, resource}` pairs | A UI regression could show one thing and store another | Test that the persisted rule equals the displayed pattern exactly; persist only to the project-scoped saved-rule store, never into a shipped config file |
| `G-04` | `AS-4` | Ticket replay, stale `provider_epoch`, or a concurrent race on a bounded-use ticket | Immutable tickets; atomic `uses` decrement; epoch bump on restart/cancel; both outcomes audited | A clock rollback could extend a TTL | Time from a monotonic source for TTL evaluation; a clock-jump test; keep the atomic decrement |
| `G-05` | `AS-4` | `yolo` auto-allow **composed with** a `full-access` sandbox profile yields broad authority from two independent switches | The catastrophic gate is irreducible; `full-access` requires explicit audited activation | Each switch alone looks bounded; **their composition is the real risk** | A single explicit, audited "reduced-safety mode" acknowledgement that states the composed scope; neither switch is reachable from project config; the active composed posture is displayed in every surface |
| `G-06` | `AS-4` | A slow or hung policy engine stalls a turn and is treated as a stall rather than a denial | Bounded decision deadline; timeout ⇒ deny with reason; audited | A deadline tuned too tight produces denial storms | Deadline is configuration; the timeout path is tested; a denial storm is surfaced as an anomaly, not silently retried |
| `G-07` | `AS-4` | A headless run configured with an allow-all posture approves everything non-interactively | Headless posture derives from policy and never blocks on stdin; ACP clients without the permission capability resolve to reject | A CI configuration that must not prompt may be tempted toward allow-all | Schema forbids `allow`; test that headless with an empty policy denies every effectful class; a headless denial is a distinct documented exit code, never a success |
| `G-08` | `AS-3` | A hook returns a "loosening" result that widens the effective decision | Hooks may only tighten or block; invocations and outcomes logged | A hook that fails open is treated as neutral | A hook failure is isolated and the action proceeds at its **original** authority; a hook result is intersected with the guard decision, never unioned |
| `G-09` | `AS-3` | A second permission system appears inside a domain, connector, extension, or surface | Architectural rule: one decider | New code can drift | CI architecture gate: a static check that no crate other than the guard evaluates policy and **no path-policy evaluation exists outside the guard**; a path-shaped `exec.run` rule is rejected at load; every new effect path must add a guard assertion (`DEC-025`, `REQ-SEC-023`, `REQ-SEC-025`) |
| `G-10` | `AS-3`,`AS-4` | The same glob means different things to guard and to the sandbox, so an allow is not an allow | Shared pattern grammar | Grammar drift across two implementations | Parity test over one shared pattern corpus asserting an identical decision in both layers; grammar is versioned; exactly one path grammar (`fs.*`, `MatchMode::Path`) and one command matcher (`exec.run`, `MatchMode::Raw`) exist (`DEC-025`) |

### T-7 — Audit integrity (`CMP-audit`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `D-01` | `AS-5` | Entry removed, reordered, truncated, or modified in place | Hash chain + dense `seq` + per-segment Merkle roots; `audit verify` reports the failing `seq` | A local actor who also rewrites the local roots defeats local-only verification | Roots are always signed and anchored at a **declared level**; the default is `local-sink`, a validated append-only sink outside the audit store root (`DEC-022`, `REQ-AUDIT-004`); see `D-02` |
| `D-02` | `AS-5`,`FO-8` | Rewrite entries **and** recompute local roots to hide the tampering | Signed segment roots; anchoring at a declared level; the `local-trust` posture is labeled everywhere | The default is `local-sink`, which is stronger than the old local-only default but weaker than `off-box`; **fabrication and the unanchored tail are not detected by any local anchor** | Surface the anchoring **level** wherever audit history is shown; make `off-box` required for any deployment declaring an off-box trust requirement; a run that cannot reach its configured anchor fails the release gate rather than degrading silently; `audit verify` renders the precise claim boundary (`REQ-AUDIT-007`) |
| `D-03` | `AS-5`,`FO-7` | **Omission**: an effect happens and is never recorded | Coverage census over a declared class registry; uncovered class fails loudly | The census cannot detect one missing runtime effect in an otherwise covered class, nor an undeclared class | Prepare/settle each effect under a stable ID; reconcile IDs across session, audit and external/workspace observations; keep the class census as a separate wiring check (`DEC-031`) |
| `D-04` | `AS-5`,`FO-7` | Append fails (disk full, rotation error) and the effect proceeds unrecorded | Append I/O error fails the guarded action closed | Pre-flight space is not specified | Space pre-flight before large appends; typed error; a design where the effect is denied rather than committed unrecorded (already stated in `ARCH/14`) |
| `D-05` | `AS-5`,`AS-6` | Cross-store disagreement: a session event or analytics row references an effect with no audit entry | Cross-store consistency invariant; reconciliation check flags both directions | A reconciliation gap discovered late is easy to dismiss | Treat a reconciliation gap as an incident with an owner; never merge silently; the check runs in the acceptance suite |
| `D-06` | `AS-2`,`AS-5` | Redaction fails and the entry is chained anyway | Redaction error refuses the entry | — | Keep; add a test that forces a redaction failure and asserts refusal |
| `D-07` | `AS-2`,`AS-6` | An audit read or export leaks content | Access-controlled reads; refs not payloads; export carries the chain proof | The export sink is a new egress path | Export is a declared, sanitized, audited path; the bundle is verified by the recipient before trust |
| `D-08` | `AS-5` | Two processes append to the chain concurrently and interleave | Exclusive append lock; atomic `head` replace | Session ownership is **process-local in v1** (`ARCH/07` Open question 2) | Cross-process file lock for the append path; a concurrency test appending from two processes; verify must pass after concurrent appends |

### T-8 — Orchestration, sub-agents, and peer agents (`CMP-orch`, `CMP-acp` client mode)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `O-01` | `AS-4`,`FO-9` | A child requests authority its parent does not hold | Effective child authority = parent ceiling ∩ declared scope ∩ agent rules; limits may only narrow | Derivation is spread across spawn, tool materialization, and per-call assert | Assert the intersection at spawn and re-assert at each effect; a spawn that would exceed the ceiling is rejected typed |
| `O-02` | `AS-4` | A peer-supplied path/tool/argument is forwarded without local authorization | Core tickets never cross the ACP boundary; the peer returns a receipt | A forwarded `fs`/`terminal` client call could be treated as pre-approved | Every peer request is a **proposal** re-authorized locally; a forwarded request that matches a saved rule still records its own decision |
| `O-03` | `AS-7` | A peer never finishes, or floods output | Bounded receipt size, per-child budgets, wall-clock ceilings, cancellation cascade | A hostile peer can stall a slot | Slots are held until close; a bounded `await` auto-backgrounds rather than freezing the parent; hard cap with kill |
| `O-04` | `AS-9`,`AS-3` | A peer's permission request is presented as if it were HorizonCode's own — a borrowed approval | Permission policy is per session; the handler set is forwarded to the local UI/queue | A user who cannot tell who is asking will approve | The approval prompt **must** show the peer's identity, the peer's requested action, and that the effect executes in the peer's runtime; an approval is bound to `(peer, tool, resource)` and is not reusable |
| `O-05` | `AS-1` | Two children write the same scope, or a worktree lease expires and is reused | Write leases; isolated checkouts; deterministic merge arbitration; stale lease reaping | Lease identity is key-based; a recycled id could alias | Lease identity includes the child id and a monotonic epoch; merge conflict surfaces evidence and stops the branch; never a silent overwrite |
| `O-06` | `AS-4` | Depth/count/parallel bounds are raised by a project-scoped config | Bounds come from user/global configuration; a spawn may narrow only | Same `FO-13` shape as `G-02` | Project config may only narrow orchestrator bounds; test at the config-merge level |
| `O-07` | `AS-4`,`AS-1` | A hostile peer sends crafted/oversized/out-of-order protocol frames | Adapter validates before anything is applied; typed failure; nothing partially applied | Unknown fields/methods could be silently ignored | Reject unknown method, oversized frame, and out-of-order transition with a typed error; never map an unadvertised tool name to an implementation |

### T-9 — Extensions and supply chain (`CMP-config`, `CMP-mcp`, skills, plugins, hooks, dependencies, catalog data)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `X-01` | `AS-10`,`AS-1` | A malicious skill's instructions subvert the run | Deny-by-default enable; pin by version/hash; quarantine scan; instructions are untrusted data | Content is judged at review time only | Injection corpus per skill batch; provenance shown before enable; a pin mismatch refuses to load until re-pinned |
| `X-02` | `AS-10` | Pin bypass through digest normalization (line endings, Unicode normalization, case, path spelling, file-set omission) | Pin is a version + content hash | A naive digest over raw bytes or names can be made to collide across equivalent encodings | Digest over a **normalized** canonical file-set manifest (relative path, normalized bytes, mode) rather than names; a mismatch refuses; add normalization fixtures to the test corpus |
| `X-03` | `AS-10`,`AS-8` | A hostile package escapes its root at install (`..` members, absolute members, symlink members, decompression bomb) | Install **copies** into a cache rather than linking; symlinks resolved and verified; bounded extraction | Extraction budgets (file count, total bytes) are not yet fixed | Extraction confined to the cache root with declared file-count/byte budgets; absolute and `..` members rejected typed; no symlink members; nothing lands outside the package |
| `X-04` | `AS-3`,`AS-10` | A plugin claims a surface it does not own (core patching, raw hooks, arbitrary renderers) | Closed surface set in the manifest; review gate | A future surface addition widens the set | Manifest schema rejects unknown surfaces; a contract-compat window rejects version skew; no surface may patch core behavior |
| `X-05` | `AS-3`,`AS-4` | A hook becomes a policy-loosening or arbitrary-execution vector | Hooks tighten/block only; every invocation and outcome logged; failure isolated | A command hook is still arbitrary code execution at hook time | Hook commands run confined with network denied at the tier's declared level and workspace-scoped writes; hook exit status is interpreted only as tighten/block/observe; a hook that tries to loosen is rejected and audited |
| `X-06` | `AS-1`,`AS-3` | A malicious MCP server squats a native tool name or shadows a reserved prefix | Namespacing (`mcp__<server>__<tool>`), name validation, scoped registration, frozen registration identity | A server named to mimic a native tool could still confuse a human | Reject collisions and reserved prefixes; show the origin of every advertised tool in the inspection surface; a call to a removed tool fails typed rather than rerouting |
| `X-07` | `AS-7` | A server floods, loops, or hangs | Per-server timeout, pagination cap, dedupe, bounded reconnect | Response bytes unbounded (see `N-05`) | Byte ceilings per method; abort typed; a repeated failure auto-disables the server with an audit entry |
| `X-08` | `AS-1`,`AS-3` | A server requests client filesystem/terminal services beyond its declared need | The same guard path for client fs/terminal calls; writes go through the governed write path | A server could probe for capability by asking | A server's service requests are proposals; the approval shows the requesting server; no auto-grant; a request outside the declared scope is denied and audited |
| `X-09` | `AS-2`,`AS-3` | The model-catalog **data** is a supply chain: an upstream change redirects traffic, alters capability claims, or supplies the pricing/limit values we then bill against | Small curated primary catalog with per-row provenance; runtime enrichment is **opt-in** with offline-by-default behavior; no full-dataset snapshot in the binary by default; attribution unconditional (`DEC-021`) | Upstream title to every byte of a community-curated dataset is not fully provable; no contributor agreement; database rights unaddressed; upstream disclaims accuracy, so pricing/limit errors are our operational liability (`DEC-021` residual risk) | Schema-validate every record; per-row provenance (source, retrieval date, method, pinned revision) plus a content hash for every cache/snapshot; a descriptor may not introduce an endpoint, auth scheme, or credential reference; live data MUST NOT silently overwrite pinned eval fixtures; no third-party marks redistributed |
| `X-10` | `AS-10` | A registry listing is treated as trust; blind auto-install | No auto-install; discovery ≠ trust; allow/deny lists and a managed lockdown | Marketplace presence is a social signal users over-trust | Show provenance and requested permissions before enable; a managed lockdown can restrict the permitted set; no registry's trust policy is inherited |
| `X-11` | `AS-5`,`AS-3` | Compromised upstream dependency or build script poisons the binary, the notices bundle, or the audit chain | License allowlist gate in CI (`DEC-012`); lockfile-pinned revisions; provenance records for adapted code; generated notices shipped with the binary | A malicious release **inside** the allowlist is not detectable by a license check | Build with locked revisions; dependency-change review in CI; the notices bundle is generated from the resolved graph so a silent addition changes it visibly; treat this as **disclosed residual risk**, not "solved" |
| `X-12` | `AS-3` | A model-catalog or config file is itself a policy file (e.g. an endpoint that makes the agent talk to an attacker) | Endpoints come from configuration, not from dataset fields; unknown config keys warn | A user can configure an attacker endpoint deliberately | Configuration is a user act (`TB-0`) and is recorded in the session's policy snapshot; a change of endpoint between turns is visible in the surface |

### T-10 — Cost, quotas, and denial of service (`CMP-runner`, `CMP-orch`, `CMP-tools`, `CMP-context`, `CMP-provider`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `C-01` | `AS-7` | An unbounded tool-call/step loop; the model raises its own step limit | Bounded step count; last-step forcing (tools unmaterialized, tool choice none) | A configured limit may be too high to be a real bound | Step/tool-call ceilings come only from configuration, never from model output; a session ceiling bounds the total; the last-step wrap-up is asserted by test |
| `C-02` | `AS-7` | Unbounded token/cost spend, including via compaction loops | Pre-send and pre-step budget evaluation; fail closed; tree totals capped by the session ceiling | Unknown pricing could under-enforce a cost ceiling | A ceiling with unknown pricing fails **closed** on the cost term, or is explicitly declared token-only; observed vs estimated never conflated |
| `C-03` | `AS-7`,`AS-1` | Memory/disk blow-up from huge tool output, a huge repo, or a huge diff | Output bounding + managed spill; per-transport byte ceilings; repo-map token allowance; retention | A single enormous file read in-process | Stream with hard caps; reject oversize before read; assert a session-level memory ceiling in a soak test |
| `C-04` | `AS-4` | Fork bomb / process explosion from one command | Confinement limits; tree reaping; per-effect process cap | — | Keep; test with a bounded explosion and assert the cap + reap |
| `C-05` | `AS-7` | Discovery/pagination loop | Visited-cursor set + hard page cap → typed error | — | Test the duplicate-cursor and cap-overrun cases explicitly |
| `C-06` | `AS-7` | Retry storm / rate-limit amplification against a third party | Bounded retries with jitter, `Retry-After` handling, cooldown | Retry accounting across failover chains | Bound total attempts and elapsed time per logical request across the fallback chain; record a storm as an anomaly |
| `C-07` | `AS-7` | Disk exhaustion from managed output, audit segments, session logs, analytics ledger | Retention/rotation; bounded archives | Rotation failure is itself a failure mode | Space pre-flight; prune-before-write; deny rather than commit unrecorded; surface disk pressure in the health vocabulary |
| `C-08` | `AS-7` | Sub-agent fan-out multiplying cost and concurrency | Depth/count/parallel bounds; per-node budgets; tree totals | A narrow ceiling per node can still multiply | Tree-wide totals are the sum of node ceilings **capped by the session ceiling**; fan-out cost is visible before dispatch |

### T-11 — Local state, portability, and the local attacker (`CMP-session`, `CMP-audit`, `CMP-analytics`, `CMP-config`)

| ID | Asset | Attack | Existing control | Residual risk | Mitigation to implement |
|---|---|---|---|---|---|
| `L-01` | `AS-2` | A **different** unprivileged local user reads or modifies the state directory | State directory created with restrictive permissions; credentials live in the broker/vault | Same-user processes are outside our control by construction | Refuse to start on a state directory with wrong ownership/permissions; document the OS user as a trusted principal (Out of scope) |
| `L-02` | `AS-3`,`AS-5`,`AS-6` | A local writer tampers with config, cache, or logs to influence future runs | Hash-chained audit; signed/anchored roots; config digest; policy snapshot on the session | Local-only roots do not stop a local root actor | Ownership/permission validation at load; refuse on mismatch; surface tampering; anchor off-box where the deployment requires it |
| `L-03` | `AS-5`,`AS-6` | A hostile portable session bundle is imported | Verify the chain **before** trusting; reject or quarantine with the reason surfaced | A bundle can contain fabricated *content* that verifies structurally | Import as data only; never execute anything from a bundle; header validation; the chain proof travels with the bundle so the recipient can verify |
| `L-04` | `AS-6` | A tampered log injects fabricated tool results into future context | The log is the source of truth and is append-only by discipline; tamper-evidence detects modification given an anchor | **Without an anchor, a local writer can fabricate plausible entries that verify** | Disclose precisely: tamper-evidence detects *modification*, not *fabrication by a party with write access*; the mitigation is an off-box anchor plus bundle verification |
| `L-05` | `AS-1` | A moved/renamed workspace is silently re-pointed at a different repository | Identity re-resolved before any resumed write; typed `NotFound` + re-point guidance | — | Never guess a path; the recorded resolved root is compared on resume |
| `L-06` | `AS-3` | Config relocates the state/config root outside an approved location via traversal or a symlink | Discovery is global → project; policy/config path refusal is a sandbox failure mode | A project config can name a path | Pin and canonicalize the state root; config may not relocate it outside the approved root; test |
| `L-07` | `AS-5` | Lock/head/temp file pre-created as a symlink to redirect a write | Atomic replace for `head`; exclusive append lock | Symlink-on-create races on temp and lock files | Open temp/lock/head files with no-follow and exclusive-create semantics; refuse a symlinked `head`; ownership+mode checks |

## Responsibilities

This document **owns**:

- The asset register (`AS-*`), the forbidden-outcome register (`FO-*`), the trust
  boundary map (`TB-*`), the adversary catalogue (`AV-*`), the per-subsystem threat
  tables (`T-*`), and the residual-risk register (`RR-*`).
- The statement of what each module's control is **claimed** to prove — so a
  component doc cannot quietly widen its own guarantee.
- The explicit out-of-scope list and the disclosure language for residual risk.

It **does not own**:

- Any allow/ask/deny rule, confinement profile, redaction rule, or audit record —
  those belong to `CMP-guard`, `CMP-sandbox`, `CMP-secrets`, `CMP-audit`.
- Any new requirement without a `REQ-SEC-*` entry in `ARCH/02-REQUIREMENTS.md`, and
  no new boundary rule without a `DEC-*` entry in `ARCH/04-DECISIONS.md`.
- Test suites or acceptance evidence — `ARCH/23-VERIFICATION.md` owns how the rows
  here become evidence.

## Interfaces

| Component | Relation to this document |
|---|---|
| `CMP-guard` | Owns the decision (`T-6`); this document states the properties the decision must preserve |
| `CMP-sandbox` | Owns enforcement and egress (`T-2`, `T-3`); authorization never substitutes for reach |
| `CMP-secrets` | Owns custody and redaction (`T-5`); no-value-return is a type-level property |
| `CMP-audit` | Owns evidence integrity (`T-7`); tamper-evidence strength is bounded by the anchor |
| `CMP-tools` | Owns the effect plane (`T-1`, `T-2`); is the single place a model proposal becomes an effect |
| `CMP-context` | Owns the untrusted-data framing (`T-4`); authority cannot be created by content |
| `CMP-provider` | Owns wire traffic and catalog data (`T-3`, `T-9`); dataset is data, never control |
| `CMP-orch`, `CMP-acp` | Own child/peer authority derivation and the borrowed-approval risk (`T-8`) |
| `CMP-config`, `CMP-mcp` | Own extension enablement, pinning, and confinement (`T-9`) |
| `CMP-session`, `CMP-analytics` | Own local state integrity and retention (`T-11`, `T-10`) |
| `CMP-tui`, `CMP-headless` | Own approval legibility and truthful posture display (`T-6`, `T-8`) |

## Data / state model

```
Asset        = { id, description, owner, loss_class }                  # AS-*
Forbidden    = { id, statement, rationale }                             # FO-*
Boundary     = { id, from, to, crossing_rule, enforced_by }             # TB-*
Adversary    = { id, capability, goal, reachable_boundaries[] }         # AV-*
Threat       = { id, subsystem, asset, attack, control, residual, mitigation,
                requirement[], status }                                  # T-*
ResidualRisk = { id, threat_ids[], severity, why_unclosable, treatment, owner,
                review_due }                                            # RR-*
```

Severity is qualitative and ordered: `critical` (authority or credential loss), `high`
(host or evidence integrity), `medium` (availability, cost, integrity of derived
state), `low` (hardening). A `ResidualRisk` is only closed by a **mitigation that
exists and is verified**, never by a decision to accept it silently; acceptance is a
recorded treatment with an owner and a review date.

## Flows

### 1. Every effect (the governed path)

```
proposal (model / peer / extension / user)
  → materialize: is the capability even advertised?          (CMP-tools, REQ-TOOL-003)
  → canonicalize + bind the resource set                    (CMP-guard, REQ-SEC-004)
  → evaluate → allow | ask | deny                            (CMP-guard, REQ-GUARD-001/002)
       ask → durable pending → human reply → ticket          (CMP-guard, REQ-GUARD-003)
  → validate the ticket (scope, uses, expiry, epoch)        (CMP-guard)
  → resolve + apply the confinement profile, or refuse       (CMP-sandbox, REQ-GUARD-004)
  → execute; the kernel independently denies what is out of reach
  → redact, canonicalize, chain the audit entry              (CMP-audit, REQ-AUDIT-001/003)
  → settle: split model content from UI detail                (CMP-tools, REQ-TOOL-004)
```

A refusal at **any** step is a terminal, audited, typed outcome. There is no path
that skips a step and no path that retries a step by relaxing it.

### 2. External content entering the context

```
source (repo file / page / tool output / skill body / receipt / peer frame)
  → label provenance and untrusted status
  → bound size; spill rather than inline
  → place outside the stable prefix (or as an explicitly non-cached item)
  → render as data with no instruction authority
  → any *action* it motivates re-enters flow 1 from `TB-0`
```

### 3. Introducing a new threat row

1. Name the asset and the concrete attack, not a category.
2. Name the **existing** control by component; if none exists, write "none".
3. State the residual risk in the present tense, including what the control does *not*
   cover.
4. Write the mitigation as an implementable change with an owning component.
5. Add or cite a `REQ-SEC-*`; if the mitigation changes a decision, raise a `DEC-*`.
6. Add an acceptance row in `ARCH/23-VERIFICATION.md`; a threat with no evidence path
   is unowned work.

## Failure modes

| Failure | Behavior |
|---|---|
| Policy parse or evaluation error | Deny with reason; audited. Never a partial evaluation. |
| Decision deadline exceeded | Deny with reason; a denial storm is surfaced as an anomaly. |
| Confinement backend unavailable or profile unappliable | Refuse the effect; audited. Never fall back to unconfined. |
| Deny glob cannot be materialized | Refuse to start the session rather than under-enforce. |
| Unconfined execution requested | Only via an explicit, audited user act; never default; never from project config. |
| Approval timeout or client disconnect | Configured per class, default deny; audited. |
| Ticket replay / stale epoch / concurrent use | `InvalidState`; audited; re-authorize normally. |
| Audit append failure | The governed action fails closed; it is never committed unrecorded. |
| Redaction failure | Refuse the entry; never chain a possibly-secret payload. |
| Anchor unreachable | Never silently degrade; surface the gap; fail the release gate. |
| Extension pin mismatch / unresolvable provenance | Refuse to load until re-pinned. |
| Hostile package member or oversized archive | Reject typed; nothing lands outside the package root. |
| Malformed tool input, frame, or config | Typed rejection; no panic; no partial application; no allocation driven by an untrusted size field. |
| Peer sends an unadvertised method or oversized frame | Typed protocol error; nothing partially applied. |
| Budget ceiling exhausted | Fail closed with the exhausted term recorded. |
| Unknown guard mode or corrupt saved-rule store | Fall back to the most restrictive posture; warn; audited. |

## Configuration

Security-relevant posture is configuration, discovered global → project with
nearest-wins, and **project scope may only narrow**. These keys are owned by their
modules (`ARCH/12`, `ARCH/13`, `ARCH/14`, `ARCH/18`); this table is the security index,
not a second definition.

| Group | Keys that change the security posture | Cannot be set by project scope |
|---|---|---|
| Guard | `guard.mode`, `guard.unmatched`, `guard.approval.default_timeout_ms`, `guard.rules[]` | `unmatched: "allow"` is invalid in any layer; a project layer cannot widen an outer deny |
| Sandbox | `sandbox.profile`, `sandbox.tier`, `sandbox.workspace.*`, `sandbox.deny[]`, `sandbox.network.*` | `profile: "full-access"`, unconfined execution, `tier: "remote"` |
| Audit | `audit.enabled`, `audit.anchor.{sign,offbox,sink_path,trust_requirement,cadence}`, `audit.retention.mode`, `audit.export.require_chain_proof` | setting `anchor.offbox` below the declared `anchor.trust_requirement`; `anchor.sign: false`; `anchor.sink_path` outside the approved state layout; disabling audit for a governed effect |
| Orchestrator | `orch.max_depth`, `orch.max_parallel`, `orch.max_total_per_tree`, `orch.limits.*` | raising any bound |
| Extensions | `plugins.*`, `skills.*`, `hooks.*`, `mcp.servers[].enabled`, `extensions.lockdown` | enabling a third-party or project plugin; relaxing a lockdown |
| Redaction | `redaction.sensitive_names[]` (extend-only) | removing a built-in pattern |
| Analytics | `analytics.otel`, `analytics.remote_optin` | enabling either |

## Residual-risk register

Recorded, owned, and reviewed. "Accepted" here means **disclosed and bounded**, not
"fixed".

| ID | Residual risk | Severity | Why it cannot be closed now | Treatment |
|---|---|---|---|---|
| `RR-01` | A determined prompt-injection payload can still steer model behavior within the authority the user already granted | critical | Content cannot be reliably distinguished from data; detection is not a security property | Containment only: content can never grant authority (`FO-6`); injection corpus asserting **no unauthorized effect**; user-visible provenance; every consequential action re-enters the governed path |
| `RR-02` | Audit tamper-evidence is only as strong as the anchor, and the default level is `local-sink` rather than `off-box` | high | `off-box` anchoring needs a nominated remote sink or counter-signer and a trust model per deployment; a fresh install cannot invent one | **Default is `local-sink`**; `off-box` is required for any deployment declaring an off-box trust requirement; the anchoring level is surfaced wherever audit history is presented; a configured-but-unreachable anchor fails the release gate; `local-trust` labeling stays honest (`DEC-022`, `REQ-AUDIT-004`, `REQ-AUDIT-007`) |
| `RR-03` | A local writer with access to the session log can fabricate plausible entries that verify structurally; at `local-sink`, a writer with sink access can do the same to the anchor | high | Content authenticity cannot be proven by a hash chain over the same store, and no local anchor can catch a principal that can also rewrite the anchor | Off-box anchoring of roots plus bundle verification; **fabrication and the unanchored tail are explicitly not detected by any local anchor**, and `audit verify` renders that boundary rather than leaving it implied (`DEC-022`, `REQ-AUDIT-007`) |
| `RR-04` | The composed `yolo` + `full-access` posture is broader than either switch suggests | critical | Two independent widening switches exist by decision | One explicit audited acknowledgement of the composed scope; catastrophic gate irreducible; neither switch reachable from project config; posture displayed in every surface |
| `RR-05` | A compromised upstream dependency inside the license allowlist is undetectable by a license check | high | Only pinned revisions + review + the generated notices bundle reduce it; none eliminates it | Locked builds, dependency-change review, notices generated from the resolved graph, `THIRD-PARTY-NOTICES` shipped (`DEC-011`, `DEC-012`) |
| `RR-06` | The model catalog's upstream title, contributor agreement, database rights, and accuracy are not fully provable from public sources | high | Accepted upstream; not closable by us | Per-row provenance record plus cross-verification, not a stronger license claim (`DEC-021`); records schema-validated; a descriptor may not introduce an endpoint or credential; pinned eval fixtures are never silently overwritten; no marks bundled |
| `RR-07` | macOS child-process network denial is `best_effort` at that tier | high | The platform mechanism available to that tier does not equal the Unix path/syscall denial | The tier **declares** `best_effort` with its residual; the level is surfaced wherever a network-restricted profile is presented and recorded in the tier's acceptance record; a caller requiring `enforced` is **refused** rather than downgraded, and no document states "network off" as what this tier enforces (`DEC-026`, `DEC-027`, `REQ-GUARD-004`) |
| `RR-08` | The Windows tier's job objects do not by themselves deny paths or network; the application-container boundary plus ACLs carry that, so its network level is `capability` (deny-by-absence) rather than a syscall filter (`ARCH/13` §Platform notes) | high | Different kernel mechanism, different proof obligation | Its own acceptance matrix and record naming the declared level; the level is surfaced and a stronger requirement is refused; limits stated honestly rather than described as equivalent (`DEC-026`, `DEC-027`) |
| `RR-09` | Session ownership is process-local in v1, so two processes can drive one session | medium | A durable cross-process owner is deferred (`ARCH/07`) | Cross-process append lock + audit concurrency test; a single-controlling-connection rule per session; do not claim multi-editor collaboration before this closes |
| `RR-10` | Enforced `exec.run` patterns match argv tokens, not interpreted semantics; a shell re-parses an argument | medium | A command wrapper is opaque to a prefix rule; the kernel boundary is the real control | Pattern grammar states this and `exec.run` carries no path-shaped resources; the kernel deny set is the boundary; the tool-plane argument scan is extraction/escalation only and may never be the sole control; a shim test asserts the deny still applies (`DEC-024`, `DEC-025`) |
| `RR-11` | Cost ceilings cannot be enforced precisely when pricing is unknown | medium | Pricing is external, versioned, and may be absent | Unknown pricing is reported as unknown, never fabricated; a cost ceiling with unknown pricing fails closed on that term or is declared token-only |
| `RR-12` | Secrets already present in workspace files are readable unless they match a deny pattern | medium | Content inspection at scale is not a boundary | Deny-glob set is extend-only and reviewed; preflight secret scan warns (and may deny) on changed files; the limit is stated rather than implied |
| `RR-13` | A hostile peer agent can burn budget while staying inside its ceiling (slow liveness) | medium | Liveness of an external process is not a security property | Hard wall-clock and output caps, slot release on close, storm anomalies recorded, a bounded `await` auto-backgrounds |
| `RR-14` | A same-user process can read HorizonCode state and any credential the OS user can reach | medium | The OS user is the trust principal; this is a deliberate boundary, not a defect | Restrict permissions, validate ownership at load, document the boundary in §Out of scope |

## Out of scope

Explicitly **not** claimed, mitigated, or tested by this document:

1. **The OS user as adversary.** Anything the invoking user can already do
   (read their own files, read their own process environment, replace the binary on
   their own PATH) is outside the boundary. Multi-user hosts: a *different*
   unprivileged principal is in scope (`AV-6`) and is handled by permission
   validation, not by cryptography.
2. **Kernel, bootloader, firmware, or hypervisor compromise.** Enforcement
   primitives are assumed correct for the supported kernel range; a pinned syscall
   filter set is the mitigation, not a proof.
3. **A malicious or coerced human operator.** If the user approves a denied action,
   the system records the approval honestly; it does not protect the user from
   themselves. The controls here make approval *legible* (who, what, which pattern),
   not impossible to misuse.
4. **Model alignment and truthfulness.** The model may be wrong, evasive, or
   adversarial. The system bounds what a wrong model can *do*; it does not make the
   model right.
5. **Content-level injection *detection*.** We claim authority containment and
   honest labeling. We do not claim reliable recognition of hostile text.
6. **Provider-side security.** Endpoint compromise, provider staff misconduct,
   retention of prompts by a third party, and a hostile model catalog operator are
   out of scope; egress policy and `REQ-ANALYTICS-004` limit what we *send*.
7. **Confidentiality against a granted reader.** Once a user grants read access to
   the workspace, a sub-agent in that scope can read it. Scope minimization and
   ceiling intersection reduce this; they do not prevent it.
8. **Availability under a determined network attacker.** Rate limiting, retries, and
   caching reduce impact; a hostile network can still deny service to third-party
   endpoints. The offline snapshot path exists precisely because this is accepted.
9. **Legal, licensing, and trademark compliance.** Owned by `DEC-011`, `DEC-012`,
   `ARCH/05`, and the release checks in `ARCH/23`.
10. **Physical and cross-tenant attacks on hosted infrastructure.** Not applicable to a
    self-contained binary; a `remote` sandbox tier inherits that tier's own model and
    is documented with it.

## Requirements mapping

`REQ-SEC-001..003` predate this document; `REQ-SEC-004..025` are derived from it and
are added by it.

| REQ | Threat rows |
|---|---|
| `REQ-SEC-001` (license allowlist) | `X-11`, `RR-05` |
| `REQ-SEC-002` (external content is data) | `P-01`…`P-07`, `RR-01` |
| `REQ-SEC-003` (targets validated before use; guard authorizes, sandbox enforces reach, the argument scan is a signal only) | `F-01`, `N-01`, `G-01`, `E-03`, `RR-10` |
| `REQ-SEC-004` (canonicalization + re-validation at use) | `F-02`, `G-01` |
| `REQ-SEC-005` (containment at the enforcement layer) | `F-01`, `F-04`, `E-04` |
| `REQ-SEC-006` (no shell-string construction; env allowlist) | `E-01`, `E-02` |
| `REQ-SEC-007` (one mediated egress, resolve-then-check) | `N-01`…`N-04`, `N-06` |
| `REQ-SEC-008` (content cannot grant authority, and cannot grant network either) | `P-01`…`P-07`, `N-06`, `RR-07`, `RR-08` |
| `REQ-SEC-009` (secret non-disclosure incl. errors) | `S-01`…`S-08` |
| `REQ-SEC-010` (confinement independent of authorization) | `E-04`, `RR-07`, `RR-08` |
| `REQ-SEC-011` (no ambient privilege) | `E-04`, `G-05` |
| `REQ-SEC-012` (audit completeness + tamper detection + census) | `D-01`, `D-03`, `D-04` |
| `REQ-SEC-013` (fail-closed resource bounds) | `C-01`…`C-08` |
| `REQ-SEC-014` (sub-agent/peer authority intersection) | `O-01`…`O-07` |
| `REQ-SEC-015` (extension pinning and explicit enable) | `X-01`, `X-02`, `X-10` |
| `REQ-SEC-016` (extension processes confined at the tier's declared network level; hooks tighten only) | `X-03`…`X-05`, `N-06`, `RR-07`, `RR-08` |
| `REQ-SEC-017` (catalog data is data) | `X-09`, `X-12`, `N-04` |
| `REQ-SEC-018` (local state ownership/permission validation) | `L-01`, `L-02`, `L-07` |
| `REQ-SEC-019` (path retargeting refused) | `F-04`, `L-06`, `L-07` |
| `REQ-SEC-020` (cross-store reconciliation is an incident) | `D-05` |
| `REQ-SEC-021` (unconfined execution requires an audited user act) | `G-05`, `RR-04` |
| `REQ-SEC-022` (adversarial input rejection) | `F-05`, `E-01`, `O-07`, `X-03` |
| `REQ-SEC-023` (structural boundaries are CI gates) | `G-09`, `N-06`, `D-08` |
| `REQ-SEC-024` (anchor status is surfaced, never over-claimed) | `D-01`, `D-02`, `RR-02`, `RR-03` |
| `REQ-SEC-025` (one path policy owner, one path reach owner; `exec.run` carries no paths) | `F-01`, `E-03`, `G-09`, `G-10`, `RR-10` |
| `REQ-GUARD-001..004`, `REQ-AUDIT-001..007`, `REQ-TOOL-003`, `REQ-ORCH-001..005`, `REQ-SKILL-001..004`, `REQ-PLUGIN-001..004`, `REQ-PROV-004`, `REQ-ANALYTICS-004` | The subsystem tables above are the threat-side statement of how each is enforced; each module document remains the owner of its own mechanism. |

## Open questions

1. **Anchoring default vs. tamper-evidence intent.** **Resolved by `DEC-022`.** The
   default is **`local-sink`**: roots are always signed (signing is not configurable
   off) and anchored to a validated append-only sink outside the audit store root.
   `off-box` is required for any deployment that declares an off-box trust
   requirement; a configured-but-unreachable sink fails closed; `local-trust` remains
   available only as an explicit, acknowledged, labeled posture. `REQ-AUDIT-004` was
   reworded rather than lowered, and the claim boundary is now separately testable
   under `REQ-AUDIT-007`. The residual is unchanged and stays in the register:
   **fabrication and the unanchored tail are not detected by any local anchor**
   (`RR-02`, `RR-03`). What remains open is device-key rotation/escrow
   (`ARCH/14` Open question 1).
2. **ACP permission method name.** **Resolved by `DEC-023`.** The canonical, frozen
   wire token is `session/request_permission`; no alias is accepted and
   `request/permission` is not a transition form in either direction. `ARCH/15` was
   corrected and `REQ-PROTO-002` now names the token, so `ACC-P1-03`/`ACC-P1-05` and
   the implementation agree. A second method identity is refused rather than
   transitional — that was the whole point of the question.
3. **`exec.run` rules and paths.** **Resolved by `DEC-025`.** Yes — `exec.run` rules
   match the **command token prefix only** and MUST NOT carry path-shaped resources; a
   path named by a shell argument travels as an `fs.*` resource, so exactly one path
   grammar and one command matcher exist and a path-shaped `exec.run` rule is a
   configuration error rejected at load. The reconciliation `REQ-SEC-003` could not
   state is now stated directly by `REQ-SEC-025` and `DEC-024`: the tool plane
   **extracts** and may only escalate, the guard **authorizes**, the sandbox
   **enforces reach**. Residual: a prefix rule is still not a semantic guarantee about
   what a wrapper will do (`RR-10`).
4. **macOS network-restricted profiles.** **Resolved by `DEC-026`, read through by
   `DEC-027`.** A
   `network: none` profile **is allowed** on the macOS tier; the tier declares
   `best_effort` with its residual, the level is surfaced wherever the profile is
   presented and recorded in that tier's acceptance record, and a caller requiring
   `enforced` is **refused** rather than silently downgraded. The backend is therefore
   not forced to declare itself unsupported — macOS stays a supported tier with an
   honest level (`RR-07`, `ARCH/13` Open question 5, `ARCH/23` Open question 8). What
   the read-through adds is that no statement anywhere in the set may present "network
   off" as what a tier *enforces*; it is the request the profile makes, and the
   declared level is the enforcement. `DEC-008`'s wording is unchanged — it is the
   request.
5. **Windows acceptance matrix.** Which specific filesystem, registry,
   child-process, and network restrictions are proven by which mechanism, and what
   record proves each? (`ARCH/13` Open question 1; `TODO.md` Windows-containment task.)
6. **The trust principal for local state.** Declaring "the OS user is trusted, other
   unprivileged users are not" is currently implicit. Does it belong as an explicit
   clause, and does it need to be reflected in the recorded session configuration
   (`REQ-SESS-004`) so a portable bundle states its own trust assumptions?
7. **Cross-process session ownership.** Process-local ownership plus two surfaces is
   safe only with a cross-process append lock and a single-controlling-connection
   rule. Is a durable owner required before any multi-editor claim is made?
   (`ARCH/07` Open question 2.)
8. **Machine-checkable "untrusted data" labeling.** Should the model request carry a
   typed wrapper that makes the untrusted/data status structurally explicit (rather
   than a rendered framing convention)? This would make `REQ-SEC-008` testable by
   construction; the mechanism is undecided.
9. **The catastrophic-gate catalogue.** Should the deny-by-default list that survives
   reduced-safety modes be a versioned, auditable artefact that is part of the
   security boundary and therefore a census class? (`ARCH/12` Open question 4.)
10. **Skill/plugin pin format and signature.** The pin hash format is still open, and
    whether a signature is required in addition to a digest is undecided
    (`ARCH/18` Open question 6; `TODO.md` Open decisions). `X-02` shows the digest
    definition matters as much as the algorithm.
11. **Scan-class helpers.** A deny-list scan over changed files is proposed as a
    mitigation in `P-05`/`RR-12`. Its false-positive rate and whether it may ever
    *deny* (rather than warn) are undecided; a scanner that blocks legitimate work
    would push users toward disabling it, which is worse than the risk it mitigates.
12. **Threat-row ownership and review cadence.** Each row's `status` needs an owner and
    a review date; the mechanism (a tracker column, a review checklist in the release
    gate, or both) is not yet decided.
