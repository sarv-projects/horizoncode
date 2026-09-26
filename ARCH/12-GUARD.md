# 12 — Policy Guard (`CMP-guard`)

## Purpose

`CMP-guard` is the **single authority** that answers one question for every effectful
action: *may this run now?* It is policy-as-code: ordered rules that evaluate to
`allow | ask | deny`, with a **fail-closed default deny** for anything unmatched.
It owns the rule model, rule sources and precedence, the approval lifecycle,
scoped/TTL'd authorization tickets, and the plan/act/yolo modes.

Guard **decides**; it never executes. Filesystem, network, and process effects are
performed by `CMP-sandbox`/`CMP-tools`; credentials live in `CMP-secrets`. There is no
privileged shortcut around Guard (`ARCH/03` §4.3, `REQ-GUARD-002`).

## Responsibilities

- Evaluate an action request against the merged rule set deterministically and
  return exactly one decision (`REQ-GUARD-001`).
- Expose per-action denials to `CMP-tools` so a denied tool is **absent** from the
  model's tool set, not merely blocked at call time (`REQ-TOOL-003`).
- Issue, validate, and revoke scoped, TTL'd **tickets** for authorized effects.
- Run the **ask/approve** lifecycle: create pending approvals, suspend the caller on
  a deferred await, persist an "always" rule only with the exact pattern shown to the
  user (`REQ-GUARD-003`).
- Enforce the **plan-mode hard guard** that blocks every mutating action.
- Append every decision — allow, ask, deny, timeout, revoke — to `CMP-audit`
  (`REQ-AUDIT-001`).
- Return the resolved confinement profile reference to `CMP-sandbox`; never widen the
  sandbox itself.

**Never owns:** effect execution (`CMP-tools`), kernel confinement (`CMP-sandbox`),
credential custody (`CMP-secrets`), transport/protocol mapping (`CMP-acp`/`CMP-mcp`),
or UI copy (`CMP-tui`).

## Interfaces

| Peer (`CMP-*`) | Direction | Contract |
|---|---|---|
| `CMP-tools` | inbound | `authorize(action, resources, ctx) -> Decision`; `materialize_filter()` returns the deny set used at registration time |
| `CMP-runner` | inbound | admission-time `authorize`; the runner blocks on an `ask` deferred |
| `CMP-tui` / `CMP-headless` / `CMP-acp` | both | approval prompt delivery and reply (`once / always / reject`) |
| `CMP-sandbox` | outbound | resolved profile ref + egress policy ref; Guard decides, sandbox enforces |
| `CMP-audit` | outbound | one append per decision, including denials and ticket lifecycle |
| `CMP-session` | outbound | policy snapshot + mode recorded with the session (`REQ-SESS-004`) |
| `CMP-secrets` | outbound | redaction of approval display strings; never receives raw secrets back |

Guard sits on the control path and is bounded; a slow or hung decision is a deny, not
an allow (`EDGE-038` analogue).

## Data / state model

```
Rule        = { action: Glob, resource: Glob, effect: allow|ask|deny }
Ruleset     = [Rule]                      // ordered; index = precedence
RuleSource  = GlobalConfig | ProjectConfig | AgentLevel | SessionOverride
Decision    = { effect, matched: [RuleRef], source, policy_hash }
Pending     = { id, session, action, resources[], save[], deferred, created_at, timeout }
SavedRule   = { project, action, resource }   // persisted "always" memory
Ticket      = { id, action, scope[], uses, expires_at, provider_epoch,
                approval_ref?, policy_hash, single_use }
GuardMode   = Plan | Act | Yolo
```

- **Actions** are dotted capability verbs: `fs.read`, `fs.write`, `fs.delete`,
  `fs.move`, `exec.run`, `net.connect`, `mcp.call`, `provider.request`,
  `skill.install`.
- **Resources** are the concrete target: a path or path glob (`fs.*`), a command
  token prefix (`exec.run`), `host:port` plus protocol (`net.connect`), or
  `server/tool` (`mcp.call`).
- **Wildcards:** `*` matches within one path/token segment; `**` spans path
  segments. Pattern grammar is shared with `CMP-sandbox` deny globs so a pattern
  means the same thing to Guard and to the kernel. A malformed pattern makes its
  config layer invalid, never a silent no-op.
- **Tickets** are immutable once issued; `uses` is decremented atomically at
  validation so a bounded-use ticket can never be spent twice (both outcomes audited).
  Stale `provider_epoch`, expiry, or revocation ⇒ `InvalidState`.

## Lifecycle & flows

### Startup
1. Discover config (global → project, nearest wins) and agent/session overrides.
2. Parse each source into a `Ruleset`, preserving order; reject a malformed layer and
   fall back to the previous valid layer with a warning — never fail open.
3. Concatenate `[global, project, agent, session]`; compute and freeze `policy_hash`.
4. Record mode (default `act`) and the snapshot to `CMP-session`/`CMP-audit`.

### Evaluate

```
fn evaluate(action, resources, ctx) -> Decision:
    rules = concat(global, project, agent, session)     # find-last-wins order
    if any matching rule in the *outer ceiling* (global, project) is deny:
        return deny                                    # non-overridable ceiling
    effects = [ find_last_rule(action, r, rules).effect for r in resources ]
    effect  = deny if any deny else ask if any ask else allow if any allow
              else configured_unmatched_effect          # deny by default
```

- **find-last-wins**: the last matching rule in the concatenated order decides.
- **fail-closed default**: an unmatched action resolves to the configured unmatched
  effect, which is `deny` by default and may be set to `ask`; it may **never** be set
  to `allow` (`REQ-GUARD-002`).
- **Deny ceiling**: an outer-scope deny cannot be widened by a more specific allow.
  This mirrors "project config may add, never redefine" and keeps untrusted project
  files from hollowing out a user/enterprise policy.

### Allow
Issue a ticket bound to the action, resources, `expires_at`, `provider_epoch`, and
`policy_hash`; append an audit entry; return `allow`.

### Ask / approve
1. Create a `Pending`; publish an approval event; the caller awaits the deferred.
2. Surface the prompt with the **exact** rule that "always" would persist (`save[]`).
3. Reply handling:
   - `once` — resolve the deferred; issue a single-use ticket; nothing persisted.
   - `always` — persist each `{action, resource}` in `save[]` as a `SavedRule`;
     resolve; re-evaluate other pending requests and auto-resolve those now allowed.
   - `reject` — fail the deferred (`Declined`); reject all other pending requests in
     the same session so one denial cannot be routed around.
4. Timeout is per action class; default is expiry ⇒ deny, surfaced and audited.
5. Session/process teardown fails every still-pending request as declined.

### Tickets
Effects never execute without a valid ticket. Validation checks scope match, `uses`,
`expires_at`, and `provider_epoch`; a provider restart or cancellation revokes the
ticket and bumps the epoch so stale handles fail closed.

### Plan / act / yolo
- **Plan** — the hard guard: every mutating action class (`fs.write`, `fs.delete`,
  `fs.move`, `exec.run` with side effects, `net.connect` mutations, `mcp.call`
  mutations) is forced to `deny` regardless of rules. Read-only actions proceed.
  Plan mode is a ceiling, applied after rule evaluation.
- **Act** — normal evaluation.
- **Yolo** — `ask` for non-catastrophic actions is auto-resolved to `allow`; `deny`
  rules and the **irreducible catastrophic gate** (permanent deletion, disk
  operations, security/OS changes, destructive VCS) still apply. Entering yolo
  requires explicit, audited opt-in. `allow` is never the default posture.

### Sandbox interaction (defense in depth)
Guard authorizes and passes the resolved confinement profile to `CMP-sandbox`; the
kernel independently enforces read/write/network limits. A Guard `allow` does **not**
imply filesystem or network reach — the sandbox may still deny it at the kernel, and
a sandbox denial is recorded by `CMP-audit`. Neither layer may be disabled by the
other's configuration.

### Deny removes tool definitions
At materialization, `CMP-tools` calls `materialize_filter()`: any tool whose action is
unconditionally `deny` in the effective posture is omitted from the model's tool
set (`REQ-TOOL-003`). Conditionally-asked tools remain present; their calls suspend
for approval.

## Failure modes

| Failure | Behavior |
|---|---|
| Rule parse/eval error | Deny with reason; audited (fail closed). |
| Decision deadline exceeded | Deny with reason; never an implicit allow. |
| Approval timeout | Per-class expiry; default deny, surfaced. |
| Saved-rule store corrupt | Ignore the saved layer (drop to stricter rules); warn; audited. |
| Ticket replay / stale epoch | `InvalidState`; audited; re-authorize normally. |
| Concurrent bounded-use tickets | Atomic decrement; loser fails `InvalidState`; both audited. |
| Unknown mode | Fall back to `plan` (most restrictive). |
| Secret in an approval display | `CMP-secrets` redacts before display and before audit append. |

## Configuration

JSONC, discovered global → project (nearest wins), with agent-level and session
overrides. Precedence for evaluation is global → project → agent → session
(find-last-wins).

```jsonc
{
  "guard": {
    "mode": "act",                       // plan | act | yolo
    "unmatched": "deny",                 // deny | ask — never "allow"
    "approval": { "default_timeout_ms": 120000 },
    "rules": [
      { "action": "fs.read",  "resource": "**",             "effect": "allow" },
      { "action": "fs.write", "resource": "src/**",         "effect": "allow" },
      { "action": "fs.write", "resource": ".git/**",        "effect": "deny"  },
      { "action": "exec.run", "resource": "cargo test*",    "effect": "allow" },
      { "action": "exec.run", "resource": "rm -rf*",        "effect": "deny"  },
      { "action": "net.connect", "resource": "registry.example:443", "effect": "ask" }
    ]
  }
}
```

Rule sources: global config → project config → agent-level policy → session
overrides. Session overrides are ephemeral; "always" persists to the project-scoped
saved-rule store, never into a shipped config file.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-GUARD-001` | Ordered rules → allow/ask/deny, deterministic find-last-wins evaluation. |
| `REQ-GUARD-002` | Unmatched actions default to deny (ask if configured); never implicit allow. |
| `REQ-GUARD-003` | "Always" persists the exact `{action, resource}` pattern, shown pre-confirmation. |
| `REQ-GUARD-004` | Guard passes the workspace-scoped, network-off profile to `CMP-sandbox`. |
| `REQ-TOOL-003` | `materialize_filter()` removes unconditionally-denied tools at registration. |
| `REQ-AUDIT-001` | Every decision and ticket lifecycle event appends to `CMP-audit`. |
| `REQ-SESS-004` | Mode + policy snapshot recorded with the session. |
| `REQ-SEC-003` | Filesystem and network targets validated against policy before use. |

## Open questions

1. **Granular approval categories for v1** — which action classes get their own
   timeout/decision independently of the global default.
2. **Session-scoped "always"** — whether to add a bounded `session` reply alongside
   `once`/`always`/`reject`, and how it interacts with durable saved rules.
3. **Saved-rule scope key** — project identity vs. workspace path when a repository
   is moved or opened through a symlink.
4. **Catastrophic-gate catalogue** — the exact deny-by-default action list that
   survives yolo, and how it is versioned.
5. **Wildcard/glob unification** — confirm one grammar shared with `CMP-sandbox` and
   the exact escape rules (leading `!`/`^`, character classes) for parity.
