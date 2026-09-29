# 12 — Policy Guard (`CMP-guard`)

## Purpose

`CMP-guard` is the **single authority** that answers one question for every effectful
action: *may this run now?* It is policy-as-code: ordered rules that evaluate to
`allow | ask | deny`, with a **fail-closed default deny** for anything unmatched.
It owns the rule model, rule sources and precedence, the approval lifecycle,
scoped/TTL'd authorization tickets, plan/act posture, and explicitly activated
run-scoped reduced-approval grants.

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
| `CMP-tools` | inbound | `authorize(action, resources, ctx) -> Decision` **decides once** and issues its grant; `consume(same request) -> Decision` **spends that grant** at the effect boundary and decides nothing. `materialize_filter()` returns the deny set used at registration time |
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
Ruleset     = [Rule]                      // ordered only within one authority layer
RuleSource  = GlobalConfig | ProjectConfig | AgentLevel | ThreadRestriction
Decision    = { effect, matched: [RuleRef], source, policy_hash }
Pending     = { id, session, action, resources[], save[], deferred, created_at, timeout }
SavedRule   = { project, action, resource }   // persisted "always" memory
Ticket      = { id, action, scope[], uses, expires_at, provider_epoch,
                approval_ref?, policy_hash, single_use }
GuardMode   = Plan | Act                 // execution posture, never project-settable
ApprovalPosture = Standard | AutoApproveEligibleAsks
RunPostureGrant = { run_id, actor, classes[], scope_digest, policy_digest,
                    sandbox_profile, expires_at, composed_full_access, ack_digest }
```

- **Actions** are dotted capability verbs: `fs.read`, `fs.write`, `fs.delete`,
  `fs.move`, `exec.run`, `net.connect`, `mcp.call`, `provider.request`,
  `skill.install`.
- **Resources** are the concrete target: a path or path glob (`fs.*`), a command
  token prefix (`exec.run`), `host:port` plus protocol (`net.connect`), or
  `server/tool` (`mcp.call`).
- **One path matcher, one command matcher** (`DEC-025`). A path-shaped target is
  always an `fs.*` resource; `exec.run` resources match the **command token prefix
  only** and MUST NOT carry path-shaped resources. A path-named `exec.run` resource
  is a **configuration error, rejected at load** — it cannot be expressed, so a
  second, unenforceable path policy cannot appear. A path protection stays fully
  expressible as an `fs.*` rule.
- **Guard is the sole path *authorization* owner; `CMP-sandbox` is the sole path
  *enforcement* owner** (`REQ-SEC-025`). `CMP-tools` is a resource extractor: it may
  attach an `fs.*` resource for a path named by a shell argument and may refuse an
  unparseable escape, but it never returns a path decision and is never the sole path
  control.
- **Built-in external-directory floor rule.** An `fs.*` resource that names an
  absolute path **outside the granted roots**, is not deny-globbed, and is not
  explicitly allowed for that same action and resource resolves to `ask` — the
  single `external_directory` ask, and Guard is the one decider for it. An
  `fs.read` allow cannot exempt `fs.write`, `fs.delete`, or `fs.move`. The floor is
  **overridable toward `deny`**
  (a deny-glob, a protected subpath, or a more specific deny rule wins immediately)
  and **never toward a silent `allow`**. A caller that requires the effect to be
  *refused* rather than asked, or that requires a tier which can confine the reach,
  is refused by the enforcement layer (`REQ-SEC-010`) — not resolved here.
- **Wildcards:** `*` matches within one path/token segment; `**` spans path
  segments. Pattern grammar is shared with `CMP-sandbox` deny globs so a pattern
  means the same thing to Guard and to the kernel. A malformed pattern makes its
  config layer invalid, never a silent no-op.
- **Tickets** are immutable once issued; `uses` is decremented atomically at
  validation so a bounded-use ticket can never be spent twice (both outcomes audited).
  Stale `provider_epoch`, expiry, or revocation ⇒ `InvalidState`.

## Lifecycle & flows

### Startup
1. Discover user/global config (then project, nearest wins) and agent/session
   restrictions.
2. Parse each source into a `Ruleset`, preserving order within that layer; reject a malformed layer and
   fall back to the previous valid layer with a warning — never fail open.
3. Resolve each layer independently. The user/global layer is the base policy;
   project, agent, and Thread layers may only narrow that authority. Existing source
   code currently flattens layers and is defective; AX-370 owns this correction.
   Compute and freeze `policy_hash` from the composed result.
4. Record the requested safe posture (default `act`) and the policy snapshot to
   `CMP-session`/`CMP-audit`; create a reduced-approval grant only after run-scoped
   user acknowledgement.

### Evaluate

```
fn evaluate(action, resources, ctx) -> Decision:
    layers = [user_policy, project_restrictions, agent_restrictions,
              session_restrictions]
    for each resource:
        base = resolve_last_match_within_layer(user_policy, action, resource)
               ?? configured_unmatched_effect          # deny by default
        restrictions = resolved matching effects from project, agent, and Thread layers
                       # no match is NoOpinion, not a synthetic deny
        effect = max_restrictiveness(base, restrictions) # deny > ask > allow
    return combine_resources(effect) and apply_external_floor(action)
```

- **Rule precedence.** Last matching rule wins only within one source/layer.
  Across authority layers, use `deny > ask > allow`; project, agent, or session
  `allow` cannot lower an upstream `ask` or `deny`. A user changes the user policy
  through a trusted settings surface; lower-trust project content cannot widen it.
  A one-use approval ticket authorizes only the exact pending effect and does not
  rewrite persistent policy.
- **No-match semantics.** A lower-trust layer with no matching rule contributes
  `NoOpinion`; it does not synthesize a deny that masks the user policy. The user
  policy's configured unmatched effect is applied only when that layer has no match.
  Explicit project, agent, or Thread rules are restrictions and compose monotonically
  with that base (`deny > ask > allow`), so they can make a request more restrictive
  but cannot relax an explicit or default user/global ask/deny. Explain output reports
  `NoOpinion` distinctly from an explicit allow. Test no-match, explicit allow/ask/
  deny, and unmatched defaults at every layer.
- **External-directory floor.** After the deny ceiling and layered rule evaluation, an
  `fs.*` resource naming an absolute path outside the granted roots that matched
  neither a deny glob nor an explicit user/global allow for that same action and
  resource is raised to `ask` by the built-in
  floor rule. The floor only ever **raises** the effect (deny > ask > allow); it can
  never lower an existing deny, and a configuration may not set it to `allow`
  (`REQ-SEC-025`, `DEC-024`). The `CMP-tools` extraction that supplies the `fs.*`
  resource may likewise only raise, so the same `deny`/`ask`/`refuse` outcome is
  reached whether the path arrived from a tool argument or from configuration. A
  project, agent, or Thread rule cannot waive this floor; a deliberate exception must
  be configured by the user/global policy owner and still cannot override a deny.
- **fail-closed default**: an unmatched action resolves to the configured unmatched
  effect, which is `deny` by default and may be set to `ask`; it may **never** be set
  to `allow` (`REQ-GUARD-002`).
- **Monotonic restriction ceiling**: project/agent/session policy cannot lower a
  user/global `ask` or `deny`; managed policy is an absolute ceiling. A user-approved
  ticket is bound to the one effect and never becomes a persistent lower-layer rule.

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

**One decision, one grant, one effect.** A call passes the seam twice, and the two
passes are different acts:

1. `authorize` evaluates the policy **once** for the call, records exactly that one
   decision, and issues the single-use grant it implies.
2. `consume` is the tool's re-assertion immediately before its effect. It spends the
   grant, re-checking scope, remaining uses, expiry, and the policy fingerprint, and
   removes it. It decides nothing, so it is **never recorded as a decision** — the
   evidence for it is the ticket lifecycle.

Asking twice where one decision was already made is refused with its reason rather
than answered by issuing a second grant, so the effect's spend is never ambiguous.

**Grant identity is *(turn, call id, action)*.** A tool-call id is a correlation
token: the protocol requires it to be unique among the calls of one response, and a
model may reuse an id later. Scoping the grant to the turn makes a reused id in a
**later** turn a new call, decided on its own merits, while a replay **inside** the
turn that issued the grant is still the same call and is refused. A provider that
reuses one id for several calls inside one turn is a malformed response, and
admission must own that check rather than letting it surface as a per-call denial
(`F-66`, `AX-356`).

**A request that names no resource is a whole-action request.** It is evaluated
against the wildcard and its ticket is scoped to the wildcard, so the grant's
recorded coverage is the wildcard too. Coverage stays one-directional: a
whole-action grant covers any named resource of that action, but a grant for one
resource never covers a whole-action request, so a request can still not widen the
grant it was issued (`F-66`).

### Plan / act / reduced-approval
- **Plan** — the hard guard: every mutating action class (`fs.write`, `fs.delete`,
  `fs.move`, `exec.run` with side effects, `net.connect` mutations, `mcp.call`
  mutations) is forced to `deny` regardless of rules. Read-only actions proceed.
  Plan mode is a ceiling, applied after rule evaluation.
- **Act** — normal evaluation.
- **Auto-approve eligible asks** (historical alias: “yolo” / “bypass approvals”) —
  transforms only eligible `ask` results into scoped, expiring, audited grants inside
  a user-confirmed run ceiling. It never overrides explicit `deny`, catastrophic
  operations, full-access acknowledgement, unavailable enforcement, managed locks,
  production/external-effect requirements, or configured network boundaries
  (`REQ-GUARD-005`, `DEC-040`). Store a preference separately from activation. Project,
  agent, plugin, prompt, or model content cannot activate or widen this posture.
  Activation displays affected classes, sandbox/network tier and residual, child
  inheritance, external actions that remain gated, and expiry. Active posture is
  visibly labeled in every effect-capable surface; turning it off fences new dispatch
  and revokes unused tickets. The combination with `full-access` requires one
  composed local acknowledgement stating the combined scope (`ARCH/22 G-05`).
- `allow` is never the default posture. A persistent “always” rule is not the same as
  auto-approval mode and remains an exact, visible, scoped pattern.

### Sandbox interaction (defense in depth)
Guard authorizes and passes the resolved confinement profile to `CMP-sandbox`. The
selected backend enforces only the reach boundary it declares and has acceptance
evidence for; no generic kernel guarantee is inferred. A Guard `allow` does **not**
imply filesystem or network reach — the sandbox may still deny it, and a sandbox
denial is recorded by `CMP-audit`. Neither layer may be disabled by the other's
configuration (`DEC-037`).

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
| Unknown or project-supplied authority mode | Reject that field/layer; remain at `plan` or the previous stricter effective posture. Never infer auto-approval. |
| Secret in an approval display | `CMP-secrets` redacts before display and before audit append. |

## Configuration

JSONC, discovered global → project (nearest wins), with agent-level and Thread
restrictions. File discovery precedence is distinct from policy authority. The
effective policy resolves last-match only inside one layer, then composes
monotonically (`deny > ask > allow`); never apply find-last-wins across layers.

**Source status at `23d4ce8` / HEAD `cbba87b`.** Current Rust source does flatten
the rule layers before selecting its last match. Global/project deny ceilings are
checked separately, but a lower-trust project allow can override a global ask for
an in-root resource. This is a known defect assigned to `AX-370`, not the target
behavior in this document.

```jsonc
{
  "guard": {
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
overrides. The example deliberately contains no active `mode` or reduced-approval
field: project configuration may not select `plan`/`act` authority or activate
auto-approval. A user setting may store a preference, but activation is a local,
audited `RunPostureGrant` created at run start with expiry and scope. Session overrides
are ephemeral; "always" persists only the exact reviewed pattern to the
project-scoped saved-rule store, never into a shipped config file. Project rules may
constrain but cannot enable or widen the local run grant.

**Load-time validation (reject, never normalize).** A rule whose resource is
path-shaped while its action is `exec.run` makes its config layer **invalid** and is
rejected at load — a transition period where such a rule is silently ignored or
loosened is not offered (`DEC-025`, `REQ-SEC-025`). A malformed pattern, a
`guard.unmatched` value that is not `deny`/`ask`, and a negative or non-integer
`use`/`limit` are handled the same way: the layer is rejected and the previous valid
layer stands (`REQ-GUARD-002`). The equivalent CI gate asserts that no component other
than the guard evaluates path policy (`REQ-SEC-023`, `AX-121`).

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-GUARD-001` | Ordered rules → allow/ask/deny, deterministic find-last-wins evaluation. |
| `REQ-GUARD-002` | Unmatched actions default to deny (ask if configured); never implicit allow. |
| `REQ-GUARD-003` | "Always" persists the exact `{action, resource}` pattern, shown pre-confirmation. |
| `REQ-GUARD-004` | Guard passes the workspace-scoped profile to `CMP-sandbox` and reads the tier's **declared** network guarantee level; a level the tier cannot provide is refused, never widened (`DEC-026`). |
| `REQ-TOOL-003` | `materialize_filter()` removes unconditionally-denied tools at registration. |
| `REQ-AUDIT-001` | Every decision and ticket lifecycle event appends to `CMP-audit`. |
| `REQ-SESS-004` | Mode + policy snapshot recorded with the session. |
| `REQ-SEC-003` | Guard authorizes the target (allow/ask/deny); `CMP-sandbox` enforces reach before the effect. Guard never executes and never widens a profile. |
| `REQ-SEC-025` | Exactly one path authorization owner: `fs.*` resources are matched by the one shared path grammar; `exec.run` matches the command token prefix only and a path-shaped `exec.run` rule is a load-time error; the built-in external-directory floor rule resolves an outside-root path to `ask`, overridable toward `deny` and never to a silent allow (`DEC-024`, `DEC-025`). |

## Open questions

1. **Granular approval categories for v1** — which action classes get their own
   timeout/decision independently of the global default.
2. **Session-scoped "always"** — whether to add a bounded `session` reply alongside
   `once`/`always`/`reject`, and how it interacts with durable saved rules.
3. **Saved-rule scope key** — project identity vs. workspace path when a repository
   is moved or opened through a symlink.
4. **Catastrophic-gate catalogue** — the exact deny-by-default action list that
   survives reduced-approval mode, and how it is versioned.
5. **Wildcard/glob unification** — **Resolved by `DEC-025`:** there is exactly one
   path grammar. `fs.*` resources are matched with the shared path grammar
   (`MatchMode::Path`) and `exec.run` with the raw command matcher
   (`MatchMode::Raw`); the grammar is versioned and the same corpus is replayed
   against `CMP-sandbox` deny globs to assert an identical decision in both layers.
   What remains open is only the exact escape-rule surface (leading `!`/`^`,
   character classes) and how it is versioned alongside the grammar
   (`G-10`).
