# 18 — Configuration

Module LLD for `CMP-config`. One discovery hierarchy, one typed merge, and the extension surfaces that are configured rather than compiled in: project instructions, skills, hooks, plugins, memory, MCP servers, and providers.

## Purpose

Resolve everything that shapes a turn — model, mode, permissions, instructions, skills, hooks, plugins, memory scope, agents, commands, notifications, and servers — through a single, deterministic, typed configuration path. Configuration is data, validated on load, versioned with the work it shaped, and free of inline secrets. `CMP-config` owns discovery and validation; it owns no domain behavior. Target settings are edited in interactive `/settings`; non-interactive surfaces use typed config/control APIs.

## Responsibilities

**Owned.**
- **Discovery.** Walk from global scope to the nearest project configuration; nearest wins. Accept JSONC. Record which layer and which file supplied each winning value.
- **Merge & validation.** Resolve user-visible preference values separately from permission/authority ceilings. Validate both with typed, versioned schemas. Unknown or invalid keys are surfaced with source and repair guidance; safety-critical policy parse errors block new effects instead of falling back to a broader default.
- **Project instructions.** Discover `AGENTS.md`-style instruction files hierarchically (user → repository walk) and inject them as a typed context source (`REQ-CTX-005`).
- **Skills.** Discover `SKILL.md` (and sibling markdown with frontmatter), route by description, and inject instructions only when activated and only within the context budget.
- **Hooks.** Register pre/post tool, session, and compaction hooks with explicit ordering and tighten-not-loosen semantics.
- **Plugins.** Load a manifest, gate it, and expose only declared extension points; plugin code runs sandboxed.
- **Memory.** Maintain persistent project/user memory records with explicit size bounds and scope.
- **MCP/provider config.** Supply server and provider entries; secret fields are references only.
- **Agent profile and command config.** Load profile and declarative command descriptors from validated sources; config never launches or trusts an executable. See `ARCH/27` for separate discovery/install/trust/enable lifecycle.
- **Operator preferences.** Store theme tokens, accessibility, notification channels, sound, warning thresholds, and user defaults. Preferences never disable the guard or rewrite run/task evidence.
- **Migration.** Forward-only, idempotent schema migrations that never run against a half-migrated state.
- **Secrets hygiene.** Config carries secret references; values are resolved by `CMP-secrets` and never written into config, logs, prompts, telemetry, or audit.

**Not owned.** Loop and turn state (`CMP-runner`); context assembly and compaction (`CMP-context`); tool execution (`CMP-tools`); allow/ask/deny evaluation and egress (`CMP-guard`); credential storage (`CMP-secrets`); provider transports (`CMP-provider`); MCP transport lifecycle (`CMP-mcp`); skill/plugin execution (`CMP-tools` + `CMP-sandbox`).

## Interfaces

**Depends on.** `CMP-secrets` (reference resolution), `CMP-guard` (permission rules validated here, enforced there), `CMP-sandbox` (plugin isolation).

**Exposes to.**
- `CMP-context` — typed instruction sources and activated skill instructions.
- `CMP-tools` — hook registry and plugin-contributed tools.
- `CMP-provider` — provider entries, routing policy, budgets.
- `CMP-mcp` — server entries and timeouts.
- `CMP-orch` — sub-agent depth/count/isolation defaults.
- `CMP-runner` — mode, model, and permission posture for a session.
- `CMP-tui` / `CMP-headless` — effective configuration and the source of each winning value.

**Public surface (sketch).**

```
discover(cwd)             -> [ConfigSource]        # ordered, nearest last
load(sources)             -> EffectiveConfig
instructions(cwd)         -> [InstructionSource]
skills.list()             -> [SkillSummary]        # name + description only
skills.activate(name)     -> SkillBody
hooks.fire(event, ctx)    -> HookOutcome           # continue | block | restrict
```

## Data / state model

**Preference value order (later preference wins, unless a managed lock fixes the value).**

```
defaults → managed defaults → project preference walk (outer→nearest) → user preferences → selected profile → session → explicit run override
```

A managed **lock** is applied as a final fixed-value constraint and cannot be
overridden. A managed default can be overridden unless it is locked. Project values
are preferences only; an explicit user choice in `/settings` wins over a project
default. Agent-profile values apply only after the user selects that profile. Session
and run choices create an epoch and apply only to future attempts. Authority is not
resolved by this precedence (see below).

Each value records `(layer, file, scope, schema_version, applied_at)`; arrays use per-field merge semantics rather than a blanket concatenation rule. User settings may select another model/provider/agent within the allowed capability set; an explicit session or run selection starts a new effective settings/context epoch.

**Authority merge is separate and monotonic.** Hard runtime limits and managed policy form a non-overridable ceiling. User restrictions, project restrictions, and session/run restrictions may narrow it, but project/run content cannot grant a capability, raise a budget ceiling, weaken a permission rule, enable an extension, or widen a network destination. Effective authority is the intersection of ceilings, not a last-writer-wins field. A user approval may authorize one requested effect within the ceiling; it does not rewrite the persistent policy. See `ARCH/12`, `ARCH/22`, and `DEC-031`.

**File formats.**

| Content | Format | Merge |
|---|---|---|
| main config | JSONC | schema-directed field merge; preference precedence above, authority intersection below |
| instruction files | markdown (+ optional frontmatter) | concatenated, outer→inner |
| skills | markdown with frontmatter | deduped by name |
| custom command definitions | markdown with frontmatter or plugin manifest | validated `CommandDescriptor`; collisions rejected, never last-wins shadowing |
| agent profiles | schema-versioned JSONC / local profile file | stable profile ID + explicit source; conflicts rejected or explicitly overridden in user scope |
| plugin manifest | JSON/JSONC | schema-validated |
| MCP server entries | JSON/JSONC | array concatenation |

Each walk level may also carry instruction files, skills, and commands; the effective configuration records the origin of every winning key.

Extensions declare commands as data with a typed argument schema and owning service;
shell snippets are not a command handler. Agent profile executable declarations are
inert until separately staged, probed, trusted, and enabled. ACP Registry entries,
local paths, native agents, MCP servers, skills, plugins, and provider records retain
their source type and do not inherit one another's trust decision (`ARCH/27`).

**Discovery walk (illustrative; directory names fixed at implementation).**

```
<global-config-dir>/config.jsonc         (global)
<project-root>/<config-dir>/config.jsonc (project root)
<project-root>/sub/<config-dir>/config.jsonc (nearest project)
  → merged: global first, nearest wins per key
```

The effective value retains a `(layer, file)` record for every key so precedence can be explained.

**Instruction source.** A typed record `{path, scope, digest, content}` injected into context; nearest wins per file name, and all matching files across the walk are concatenated in outer-to-inner order.

**Skill record.** `{name, description, slash?, location, content, digest}` parsed from frontmatter. **Description routing:** only `{name, description}` enters the always-on skill summary; the body loads only on activation, bounded by `CMP-context`. A skill whose declared requirements are unavailable activates in guidance mode naming the gap; activation never grants permissions.

**Hook record.** `{name, event, matcher, handler_ref, order}`.

| Event | When | May |
|---|---|---|
| `pre-tool` | before authorization | tighten, block |
| `post-tool` | after settle | observe |
| `session-start` / `session-end` | session boundary | tighten |
| `pre-compaction` / `post-compaction` | around compaction | observe, annotate |

Semantics: a hook may **tighten** (add a restriction) or **block** (veto the action); it may never loosen or grant. Blocking is a typed outcome; ordering is deterministic (declared order, then name).

**Plugin surfaces.**

| Surface | Contribution | Gate |
|---|---|---|
| tool | new tool definition | declared schema + permission |
| provider | provider/model adapter | protocol code confined here |
| command | slash command | declared input schema |
| UI panel | panel contribution | declared slot; no raw renderer code in v1 |

A manifest may only claim surfaces from this closed set, and each claim passes the review gate.

**Plugin manifest.** `{id, version, source, content_digest, signer?, surfaces[], requested_capabilities[], hooks[], compat_window, provenance}`. Surfaces are a closed set (tools, providers, model adapters, UI panels, commands). A manifest is data, not a grant; capabilities require explicit user/managed approval and are still passed through the guard/sandbox. No plugin may patch core behavior or inject a raw hook outside the declared set.

**Memory record.** `{scope: user|project, key, value, created, updated, ttl?, bytes}` with explicit per-scope size bounds and eviction by age/size. Memory is durable and survives restart; it is distinct from session event history.

**MCP/provider entries.** MCP: `{id, transport, command/args/env | url/headers, auth, timeout, enabled}`. Provider: `{id, endpoint, auth_ref, models{}, headers}`. Every secret field stores a reference, never a value.

**Agent profile records, usage warning policies, theme tokens, and notification
preferences** are specified in `ARCH/27`; config stores requested/effective values and
provenance, while `CMP-orch` owns active limits, `CMP-provider` owns usage facts,
`CMP-analytics` owns the append-only usage ledger, and `CMP-tui` only renders them.

## Lifecycle & flows

1. **Load.** Discover all sources → parse → validate/migrate → resolve preferences and authority ceilings independently → produce an `EffectiveConfig` with source, digest, lock state, and apply boundary for each setting. A bad non-security preference leaves its prior effective value visible as stale with an error; a malformed or unreadable security policy blocks new effectful work. Reusing a previously validated policy snapshot requires its pinned digest and explicit stale status; it must never silently widen authority.
2. **Instruction assembly.** Walk user → repository, collect instruction files nearest-wins, dedupe by digest, and hand typed sources to `CMP-context`. Referenced extra instruction files are added after in-repo ones.
3. **Skill lifecycle.** Scan sources → parse frontmatter → build the description-only summary → on a relevance match or explicit invocation, activate and inject the bounded body. Skills are never bulk-dumped into context.
4. **Hook execution.** Pre-tool hooks run before authorization and may return only `continue`, `restrict`, or `block`; their result is fed into the single guard decision and cannot grant. Post-tool hooks observe; session hooks bracket the session; compaction hooks run before and after `CMP-context` compaction. A hook failure is isolated and leaves the action at its original guarded authority.
5. **Plugin lifecycle.** Install from local path → validate manifest → review gate (declared surfaces, requested permissions, provenance) → explicit per-scope enable → run sandboxed. A crash loop auto-disables the plugin and audits it. Updates apply at next activation, never mid-call.
6. **Memory.** Read/write within scope and size bounds; oversized writes are rejected typed; eviction is deterministic.
7. **Migration.** Run before the feature that needs them; failure blocks cleanly and reports the exact migration and error.
8. **Change propagation.** A setting update is proposed → typed-validated → authority-checked → atomically persisted → shown with source/effective value → applied at its declared boundary (`immediate | next_turn | restart`). A change affecting a run is versioned into that run; provider/model/agent/compaction changes create a new context epoch and never rewrite prior cost or verification facts.

## Failure modes

| Failure | Behavior |
|---|---|
| Config parse error | Fail closed for that layer; fall back to previous layer with a warning + audit |
| Unknown keys | Warning + migration note; never silently accepted |
| Unknown or malformed security-policy key | Reject policy activation, pause new effectful work, show exact source/key/error; never use a permissive fallback |
| Conflicting preference layers | Apply declared field merge order and show the winning source and shadowed values in settings |
| Invalid settings change | Keep the last valid effective value visible as stale, show the validation error, and do not partially persist |
| Migration failure | Block the dependent feature; never run against half-migrated state |
| Secret value inlined in config | Rejected typed at load; only references are accepted |
| Skill requirements unmet | Guidance naming the missing requirement; no silent degradation |
| Agent catalog cannot refresh | Keep valid local profiles; mark cached catalog stale; never install, enable, or launch based on a stale candidate |
| Executable profile path or digest changed | Refuse launch; mark profile quarantined until an explicit re-probe and trust review |
| Requested agent model unsupported by adapter | Reject the override or require explicit selection of peer-managed model; do not display the requested model as effective |
| Usage or quota is not observable | Show `unknown` with source/attempt; hard provider-spend policy blocks an unmetered route unless user explicitly selects a monitor-only policy allowed by higher-level rules |
| Notification/sound disabled | Preserve durable event and controller behavior; required approvals and stop states remain visible on attach |
| Invalid custom command or command collision | Reject descriptor and preserve built-ins; never dispatch through ambiguous alias |
| Unsupported theme color depth or contrast failure | Show validation error and effective fallback; retain non-color labels/glyphs |
| Skill/instruction injection | Untrusted content: provenance + the same injection hygiene as other external data |
| Hook throws | Isolated and logged; the action proceeds under its original authority |
| Hook attempts to loosen | Rejected; hooks may only tighten or block |
| Plugin manifest invalid | Rejected at review with a typed reason |
| Plugin crash loop | Auto-disable + audit; core unaffected |
| Plugin version skew | Rejected typed against the contract compat window |
| MCP server entry invalid | That server is disabled typed; other servers unaffected |
| Memory bound exceeded | Write rejected typed; deterministic eviction for existing records |

## Configuration

This document *is* the configuration surface. Key groups: `providers.*`, `models.*`, `routing.*`, `budget.*`, `permissions.*`, `instructions.*`, `skills.*`, `hooks.*`, `plugins.*`, `memory.*`, `mcp.servers[]`, `agents.profiles[]`, `commands.custom[]`, `orch.*`, `ui.theme.*`, `ui.layout.*`, `ui.keymap.*`, `ui.notifications.*`, `ui.sound`, `ui.accessibility.*`, `ui.usage_warnings[]`, `compaction.*`, `repository.*`, `verification.*`, and `delivery.*`. Every field is schema-versioned; migration notes accompany renames. A `SettingView` contains `{key, requested_value, effective_value, source_scope, source_ref, shadowed_sources[], locked_by?, validation_error?, capability_status?, apply_boundary, schema_version, effective_digest}`. `/settings` exposes theme tokens, contrast/color depth, reduced motion and screen-reader mode, layout/keymap, provider/model/agent, reasoning, local endpoint, context limits and compaction, routing, hierarchical run/task/worker budgets, warning thresholds, approval posture, notification channels and sound, extension enablement/provenance, evidence retention, and cost/quota display. `managed` locks win; project content cannot widen authority. Changing model/provider/agent records capability and provenance; an unavailable setting is not silently approximated (`REQ-UI-010..015`, `REQ-ORCH-007..009`, `DEC-030`, `DEC-038..040`). The slash command and mention catalogs are owned by `ARCH/27`.

**Source status (2026-09-28).** `horizoncode-config` now owns the implemented slice:
the discovery walk (global first, then project outer to nearest; a path that exists
but is unusable is reported as an issue rather than skipped), the one JSONC reader
(the guard's document validator consumes it instead of keeping a copy), the typed
settings merge with per-key provenance (`SettingView` as above, with `contributors`
added so an accumulating key can list every contributing layer), and hierarchical
`AGENTS.md` discovery with canonical-path and content-digest dedupe, the exact
`Instructions from: <path>` rendering, and the fail-closed unreadable case. One
`state_root()` resolves `$HORIZONCODE_HOME` → `~/.horizoncode` → `.` and is consumed
by the session, audit, analytics, guard, and CLI roots, so the documented layout is
the implemented one (`F-67`). The discovery and activation half of skill handling is
implemented (`AX-110`, first slice): `SKILL.md` (or a sibling `<name>.md`) is discovered under the global
`<state>/skills` directory and the project walk, frontmatter is parsed with a
YAML parser, `{name, description, slash}` alone enter the catalog, and the body
is returned only by `activate`, which re-reads the file and verifies its digest
against the listing. A malformed skill file is a diagnostic, never a silent
omission; a symlinked skill file is refused. The schema now carries the
instruction key, the two accessibility flags, the terminal-bell preference, and
the storage ceilings and defaults published in `DEC-058` (`session.log.*`,
`run.log.*`, `session.artifacts.*`, `run.artifacts.*`) with typed limit views and
lower-only validation: a configuration or project may lower a limit, never raise the compiled
ceiling, and a nonzero rule rejects zero. Every other key group above registers in
the same registry as its owner lands, so no second settings engine appears. **Not covered:** managed locks (`locked_by`) and capability status
(`capability_status`) arrive with managed policy; injection of the rendered
instruction source into the assembled context is `AX-319`; permission rules remain
validated and evaluated by `CMP-guard`.

`session.artifacts.*` is a first-class schema group for maximum inline-event bytes,
per-object and per-session encoded bytes, decoder expansion/pixel/time ceilings,
artifact retention, orphan-cleanup grace, and required durability mode. Expose
requested/effective values, current/reserved storage, and effective filesystem
durability in `/settings`; managed policy and compiled resource ceilings win, and no
default may be unbounded. `session.log.*` and `run.log.*` expose finite event/segment/
session-or-run limits, replay batch size, durability profile, and protected
control/recovery bytes plus physical-reserve allocation profile separately from
artifact bytes. Multi-hour runs require the
crash-durable profile; user settings and agent profiles cannot turn off required syncs
or raise compiled ceilings, and a limit cannot be reduced below committed plus
reserved use. `providers.<id>.termination_profile` is route-fingerprint
bound evidence, not a user-authored capability flag;
`models.output_truncation_recovery` is only a user preference between disabled and
once-per-logical-step recovery for routes with a validated remaining-context cap
profile. Unsupported/unknown finish semantics remain non-retrying.

Security-relevant parse/read failure blocks activation of the new configuration. A
previously validated snapshot may be retained only with an explicit stale warning and
without widening authority; a silently restored broader rule is prohibited. Effective
config digest is pinned to the run and changes create a new context/policy epoch.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-CTX-005` | Project instructions discovered hierarchically (user → repository walk) and injected as a typed context source |
| `REQ-GUARD-001` | Permission rules are ordered configuration validated here and evaluated deterministically by `CMP-guard` |
| `REQ-GUARD-002` | Default posture fails closed; hooks may only tighten, never allow implicitly |
| `REQ-PROV-004` | Configuration stores secret references only; values never appear in config or logs |
| `REQ-SEC-001` | Plugin/dependency provenance and the license allowlist gate plugin admission |
| `REQ-SEC-002` | Instruction files, skills, and plugin content are untrusted data, never instructions |
| `REQ-VISION-002` | Migration and validation surface actionable guidance; no silent failure |
| `REQ-VISION-003` | Product copy remains neutral; factual provider/model names and mandatory attribution have provenance and never imply an unmeasured comparison (`DEC-030`) |
| `REQ-HORIZON-002` | Durable memory and config-versioned task state survive restart |
| `REQ-UI-010..015` | Typed effective settings, accessible palette, registry-backed commands/references, and configurable notification/sound preferences |
| `REQ-ORCH-007..009` | Profile/preferences are declarative; trust/install is separate; per-agent model and quota visibility respect adapter capability and known/unknown data |
| `REQ-PERF-001` | Effective config is resolved within the warm-cache startup bound |

## Open questions

1. **`CMP-config` registration.** Resolved: `CMP-config` is registered in `ARCH/03-ARCHITECTURE.md` §2 (Capability layer). No further `DEC-*` is needed for registration; the extension surfaces it configures remain governed by `DEC-018`.
2. **Memory requirements.** Resolved: memory is covered by `REQ-MEM-001..003` in `ARCH/02-REQUIREMENTS.md` (persistent store with bounds, attributable/inspectable writes, injectable typed context source). The remaining open detail is the exact per-scope size bounds and eviction thresholds.
3. **Config format authority.** JSONC is primary; whether YAML is a supported authoring format (and how it maps to JSONC precedence) is undecided.
4. **Plugin permission model.** Whether plugins request capability grants or surface grants, and how review depth maps to v1.
5. **Hook surface freeze.** The exact v1 hook event set and whether experimental transform hooks ship or are deferred.
6. **Skill provenance signing.** Whether skills loaded from remote sources require a signature/digest gate in v1 or only local provenance.
