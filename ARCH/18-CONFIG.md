# 18 — Configuration

Module LLD for `CMP-config`. One discovery hierarchy, one typed merge, and the extension surfaces that are configured rather than compiled in: project instructions, skills, hooks, plugins, memory, MCP servers, and providers.

## Purpose

Resolve everything that shapes a turn — model, mode, permissions, instructions, skills, hooks, plugins, memory scope, servers — through a single, deterministic, typed configuration path. Configuration is data, validated on load, versioned with the work it shaped, and free of inline secrets. `CMP-config` owns discovery and validation; it owns no domain behavior.

## Responsibilities

**Owned.**
- **Discovery.** Walk from global scope to the nearest project configuration; nearest wins. Accept JSONC. Record which layer and which file supplied each winning value.
- **Merge & validation.** Deep-merge layers in a fixed order; validate against typed, versioned schemas; unknown keys produce warnings plus migration notes, never silent acceptance.
- **Project instructions.** Discover `AGENTS.md`-style instruction files hierarchically (user → repository walk) and inject them as a typed context source (`REQ-CTX-005`).
- **Skills.** Discover `SKILL.md` (and sibling markdown with frontmatter), route by description, and inject instructions only when activated and only within the context budget.
- **Hooks.** Register pre/post tool, session, and compaction hooks with explicit ordering and tighten-not-loosen semantics.
- **Plugins.** Load a manifest, gate it, and expose only declared extension points; plugin code runs sandboxed.
- **Memory.** Maintain persistent project/user memory records with explicit size bounds and scope.
- **MCP/provider config.** Supply server and provider entries; secret fields are references only.
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
hooks.fire(event, ctx)    -> HookOutcome           # allow | block | tighten
```

## Data / state model

**Layer order (later wins).**

```
defaults → user (global) → project walk (nearest wins) → agent profile → session → run override
```

Arrays merge by concatenation where order is meaningful (instruction files, MCP servers); scalars and objects override. The effective value retains a `(layer, file)` record for every key so precedence can be explained.

**File formats.**

| Content | Format | Merge |
|---|---|---|
| main config | JSONC | deep merge, later wins |
| instruction files | markdown (+ optional frontmatter) | concatenated, outer→inner |
| skills | markdown with frontmatter | deduped by name |
| commands | markdown with frontmatter | deduped by name |
| plugin manifest | JSON/JSONC | schema-validated |
| MCP server entries | JSON/JSONC | array concatenation |

Each walk level may also carry instruction files, skills, and commands; the effective configuration records the origin of every winning key.

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

**Plugin manifest.** `{id, version, surfaces[], permissions[], hooks[], compat_window}`. Surfaces are a closed set (tools, providers, model adapters, UI panels, commands). No plugin may patch core behavior or inject a raw hook outside the declared set.

**Memory record.** `{scope: user|project, key, value, created, updated, ttl?, bytes}` with explicit per-scope size bounds and eviction by age/size. Memory is durable and survives restart; it is distinct from session event history.

**MCP/provider entries.** MCP: `{id, transport, command/args/env | url/headers, auth, timeout, enabled}`. Provider: `{id, endpoint, auth_ref, models{}, headers}`. Every secret field stores a reference, never a value.

## Lifecycle & flows

1. **Load.** Discover all sources (global → project walk) → parse JSONC → merge in order → validate/migrate → produce `EffectiveConfig`. A layer that fails to parse fails closed for that layer only, falls back to the previous layer, and surfaces a warning plus an audit event.
2. **Instruction assembly.** Walk user → repository, collect instruction files nearest-wins, dedupe by digest, and hand typed sources to `CMP-context`. Referenced extra instruction files are added after in-repo ones.
3. **Skill lifecycle.** Scan sources → parse frontmatter → build the description-only summary → on a relevance match or explicit invocation, activate and inject the bounded body. Skills are never bulk-dumped into context.
4. **Hook execution.** Pre-tool hooks run before authorization and may tighten or block; post-tool hooks observe; session hooks bracket the session; compaction hooks run before and after `CMP-context` compaction. A hook failure is isolated: it cannot corrupt core state.
5. **Plugin lifecycle.** Install from local path → validate manifest → review gate (declared surfaces, requested permissions, provenance) → explicit per-scope enable → run sandboxed. A crash loop auto-disables the plugin and audits it. Updates apply at next activation, never mid-call.
6. **Memory.** Read/write within scope and size bounds; oversized writes are rejected typed; eviction is deterministic.
7. **Migration.** Run before the feature that needs them; failure blocks cleanly and reports the exact migration and error.
8. **Change propagation.** A configuration change that affects running work is versioned into that work's record so results are reproducible.

## Failure modes

| Failure | Behavior |
|---|---|
| Config parse error | Fail closed for that layer; fall back to previous layer with a warning + audit |
| Unknown keys | Warning + migration note; never silently accepted |
| Migration failure | Block the dependent feature; never run against half-migrated state |
| Secret value inlined in config | Rejected typed at load; only references are accepted |
| Skill requirements unmet | Guidance naming the missing requirement; no silent degradation |
| Skill/instruction injection | Untrusted content: provenance + the same injection hygiene as other external data |
| Hook throws | Isolated and logged; the action proceeds under its original authority |
| Hook attempts to loosen | Rejected; hooks may only tighten or block |
| Plugin manifest invalid | Rejected at review with a typed reason |
| Plugin crash loop | Auto-disable + audit; core unaffected |
| Plugin version skew | Rejected typed against the contract compat window |
| MCP server entry invalid | That server is disabled typed; other servers unaffected |
| Memory bound exceeded | Write rejected typed; deterministic eviction for existing records |

## Configuration

This document *is* the configuration surface. Key groups: `providers.*`, `models.*`, `routing.*`, `budget.*`, `permissions.*`, `instructions.*`, `skills.*`, `hooks.*`, `plugins.*`, `memory.*`, `mcp.servers[]`, `orch.*`, `ui.*`. Every field is schema-versioned; migration notes accompany renames.

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
| `REQ-VISION-003` | Configuration keys, help text, and docs carry no vendor names |
| `REQ-HORIZON-002` | Durable memory and config-versioned task state survive restart |
| `REQ-PERF-001` | Effective config is resolved within the warm-cache startup bound |

## Open questions

1. **`CMP-config` registration.** Resolved: `CMP-config` is registered in `ARCH/03-ARCHITECTURE.md` §2 (Capability layer). No further `DEC-*` is needed for registration; the extension surfaces it configures remain governed by `DEC-018`.
2. **Memory requirements.** Resolved: memory is covered by `REQ-MEM-001..003` in `ARCH/02-REQUIREMENTS.md` (persistent store with bounds, attributable/inspectable writes, injectable typed context source). The remaining open detail is the exact per-scope size bounds and eviction thresholds.
3. **Config format authority.** JSONC is primary; whether YAML is a supported authoring format (and how it maps to JSONC precedence) is undecided.
4. **Plugin permission model.** Whether plugins request capability grants or surface grants, and how review depth maps to v1.
5. **Hook surface freeze.** The exact v1 hook event set and whether experimental transform hooks ship or are deferred.
6. **Skill provenance signing.** Whether skills loaded from remote sources require a signature/digest gate in v1 or only local provenance.
