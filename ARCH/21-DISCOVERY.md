# 21 — Discovery & Extensions

How HorizonCode **discovers, inspects, and uses** external capabilities: Connector services, MCP servers, skills, plugin bundles, and peer agents over ACP. `CMP-extension-catalog` owns metadata-source federation; runtime/lifecycle responsibilities remain with `CMP-mcp`, `CMP-config`, `CMP-orch`, `CMP-acp`, and the other named owners.

Default posture: **deny-by-default**. Nothing discovered is enabled, executed, or trusted merely because it was found. Discovery is cheap; use requires explicit enable, pinned provenance, and policy approval.

## Extension manager and registry UX

`/extensions`, `/mcp` (`/mcps`), `/skill` (`/skills`), `/plugin` (`/plugins`), `/hooks`,
`/connectors` (`/apps`), `/workflows`, and `/marketplace` open the same centered
Extensions overlay, selecting the matching category. The shared surface has category
tabs for Connectors, plugins, skills, MCP servers, hooks, workflows, and marketplace;
applicable **Search**, **Installed**, and
**Create** views are scoped to the selected category. Opening or switching tabs is
read-only navigation: it does not trust, enable, install, execute, or grant permissions.
The overlay preserves the composer draft and workspace layout. Category loading is
bounded and cancellable, and one category does not wait for unrelated remote/catalog
requests. Noninteractive surfaces return typed data/results rather than claiming to
open a TUI. Search covers the official MCP Registry for MCP metadata, supported Git
marketplace formats, Agent Skills package sources, and a HorizonCode-curated
connector/service catalog that records compatibility and review evidence. The
official registry is a
discovery/index service, not an installer, code-signing authority, security verdict,
or source of HorizonCode trust. Catalog records are inert, bounded, schema-validated
metadata with publisher/source/version/license/transport/auth/provenance fields. A
catalog refresh never changes an installed artifact or active Run. See the official
[MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md).

**Pattern provenance:** the shared-modal and slash-routing reference is Grok Build's
pinned [`extensions_modal.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/extensions_modal.rs),
[`plugin.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/plugin.rs),
and [`transcript.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dispatch/transcript.rs)
(`SRC-029`; see [`ARCH/29` U-GROK-EXTENSIONS](29-SOURCE-TRACEABILITY.md#u-grok-extensions)).
HorizonCode adopts the navigation pattern only; loading, trust, install, and enable
semantics remain HorizonCode-owned.

An apparent one-click install is a guided, resumable transaction, not a single trust
grant:

```text
catalog item → inspect/pin source and version → stage in isolated install root
→ review config/permissions → supply credentials in CMP-secrets when needed
→ launch/probe initialize and list capabilities → review per-tool policy
→ explicitly enable selected tools
```

Show progress and allow safe cancellation at each step. If the server requests OAuth,
API keys, environment values, local binaries, file access, network reach, or install
scripts, present the exact need before use. Secrets are held by the secret broker and
referenced by ID; never write them into project manifests or logs. Installation may
be completed but disabled while authentication or review is pending. Removal and
rollback preserve run/audit provenance and clean only HorizonCode-owned install data.

The default **Installed** view lists each MCP server, skill, plugin, hook, or workflow
with its name/type, concise lifecycle state, and primary applicable Add/Remove/Enable
action. Selecting an item reveals provenance pins, scope, capabilities, probe details,
configuration, and recent health where applicable. **Create** starts a local MCP
config, skill package, plugin bundle, or workflow template wizard; it validates and
previews files before writing. Project-sourced definitions remain untrusted data until
user trust and policy permit their use. This progressive-disclosure presentation is
informed by iCode's focused extension configuration panels (`SRC-035`/`U-ICODE-TUI`),
but the HorizonCode default is the simpler installed-items surface above.

Implementation phases: start with the official Registry's read-only metadata API,
HorizonCode-curated Connector/service records, and a small set of curated public Git
marketplace/package sources; ship no general open upload/publish service in v1.
Add user/team catalogs later as user-controlled Git/HTTP sources under the same
metadata-only rules. The shared market's catalog coverage target is **at least 500
unique, source-resolvable listings for its first broad release, with 1,000 as the
expansion target**. The coverage report groups entries as connector/service
definitions, standalone MCP server packages, skill packages, and plugin bundles.
Versions, alternate providers for one service, duplicate source mirrors, and
components bundled inside a plugin do not inflate the unique-listing count. Counts
are reported by family and source; they are goals until a dated catalog snapshot and
coverage report prove them. Listing does not imply compatibility, security review,
publisher verification, or enablement. This avoids operating a new registry while
preserving a stable catalog adapter and provenance model.

Working first-500 planning mix: 200 Connector/service definitions, 150 standalone
MCP server packages, 100 skill packages, and 50 plugin bundles. These are planning
floors, not a waiver to accept unresolved or unsuitable items. If a family cannot
reach its floor at the required source quality, report the shortfall and revise the
release plan explicitly; provider options, mirrors, versions, and embedded bundle
parts do not fill a family floor.

## Shared extension market: items, sources, and runtime boundary

The market is a **discovery and distribution catalog**, not an executor or a universal
extension runtime. One normalized listing envelope carries a stable namespaced ID,
kind, display metadata, source identity and location, publisher claim, versions,
license evidence, component references, declared host requirements, update time, and
the evidence state for compatibility/review. Preserve the upstream manifest and
unknown fields alongside normalized fields so a newer source-format field is not
silently discarded. Source adapters fetch and validate bounded metadata; package
adapters interpret a supported format and emit a compatibility report. Unsupported
components remain visible as unsupported/ignored with source location; they do not
silently gain HorizonCode behavior.

The catalog distinguishes these entities:

| Entity | Meaning in the product | What the listing represents |
|---|---|---|
| **Connector / service** | “Connect GitHub,” “Connect Slack,” or “Connect PostgreSQL.” This is the user-facing service identity and capability family. | One service card can offer one or more provider choices. A provider is not another service listing. |
| **Connection** | A specific user's or organization's authenticated account and granted scopes for a service/provider. | Local HorizonCode state, never marketplace content; credentials stay in `CMP-secrets` and are represented by secret references. |
| **MCP server** | A concrete package or remote endpoint implementing MCP. | A raw server listing for users who want to select/configure the server directly. It can also be an implementation option under a Connector service card. |
| **Skill** | Agent Skills-compatible instructions, scripts, and resources. | A skill package. Metadata discovery does not activate its instructions or run its scripts. |
| **Plugin** | A distributable bundle with a manifest and optional skills, MCP definitions, agents, hooks, assets, or supported host-specific components. | One bundle listing. Its bundled parts do not count again toward the catalog target unless independently published as separate entries. |
| **Provider offer** | A concrete way to implement a Connector: service-operated MCP, local/remote community MCP, a future native adapter, or an explicitly integrated gateway. | A child option of the service, not a separate Connector and not a new account connection. |

The runtime resolves a service through the selected provider offer, then binds it to a
Connection and its scoped grants. `CMP-tools` remains the single model-facing tool
registry; `CMP-guard` authorizes each effect; `CMP-secrets` owns credential material;
`CMP-mcp` owns MCP protocol execution; and `CMP-sandbox` owns applicable process
confinement. A catalog listing, plugin manifest, or skill cannot bypass those owners.
`CMP-provider` remains exclusively the model/provider route registry and is unrelated
to external service connectors.

Connector coverage is a product priority. The shared catalog includes developer
services (source control, issue/project tracking, CI, deployment, cloud, databases,
observability, design, documentation, chat, security, package registries, and API
testing) plus general-work services (email, calendar, files, office, CRM, support,
research, analytics, and business systems). HorizonCode ranks developer-relevant
services first while allowing search across the shared catalog; AgentCowork may rank
the wider set later. The catalog does not imply that every service has a native
connector or is compatible with both hosts.

Initial source adapters are:

1. The official MCP Registry read API for server metadata and version/source pointers.
   Synchronization uses its cursor pagination and `updated_since`/deletion behavior;
   the API's name-substring search is not treated as a rich marketplace search engine.
   Keep an indexed copy for search, respect upstream update/deletion status, and retain
   the source revision/time. The upstream registry recommends downstream registries
   add their own search and value.
2. Local/Git marketplace catalogs in the documented Codex/Agent Plugins format, plus
   explicit Claude Code and Grok Build adapters. Support only documented fields with
   a compatibility report. A package-format adapter does not grant access to a
   vendor's hosted directory or its account credentials; do not scrape a directory
   that exposes no documented public feed.
3. Agent Skills-format packages from curated and user-selected Git sources. The open
   `SKILL.md` folder format is the package contract; source identity, revision, and
   content digest remain pinned before use.
4. HorizonCode's curated Connector/service records and approved first-party listings.
   The curated layer adds provider choices, clear compatibility evidence, and
   safe-use metadata; it does not claim ownership of upstream implementations.

Any later source adapter must use a documented public feed, a user-provided source,
or publisher authorization. Do not scrape closed vendor directories or assume that
one vendor's OAuth, hosted connector, or backend can be reused. A gateway such as an
integration platform is a provider offer only after a separate decision covers its
data handling, credentials, terms, cost, and failure model; the catalog contract must
not depend on a specific gateway.

**Catalog identity, deduplication, and status.** Stable IDs are namespaced by source
and canonical publisher/package identity. Multiple source records can point to one
canonical package; retain every provenance record and merge only when identity is
strong enough (publisher ID plus canonical upstream identity or identical immutable
digest). Similar names alone never merge. Versions and providers are children of the
entry. Conflicting claims remain separate and are visibly related for review. The
coverage metric counts each canonical entry once, type-qualified, and excludes
duplicates, provider offers, versions, and embedded bundle components.

Keep these claims separate in storage and UI: **listed**, **source-resolved**,
**format-compatible**, **host-compatible**, **probe-passed**, **security-reviewed**,
**publisher-verified**, **official**, and **enabled**. Each evidence claim has source,
time, version/digest, scope, and method; stale evidence becomes stale rather than
remaining an unqualified badge. “Listed” or a high catalog count never means safe.
Default search prioritizes source-resolved and host-compatible entries, with other
records clearly labeled and filterable. Installation remains staged and disabled
until the existing provenance, Guard, secret, probe, per-tool review, and enablement
steps succeed.

**Connection lifecycle.** A Connector card exposes a plain-language **Connect**
action; provider selection and scopes appear in focused detail only when more than one
usable provider exists or when a user chooses advanced setup. A service being listed,
installed, connected, enabled for a profile, and available to a particular Run are
separate states. One service may have several accounts and providers. Connection
records are host-local and account-scoped; do not synchronize or reuse OAuth tokens
between HorizonCode and AgentCowork. Disconnect revokes/removes the connection's
credential reference and access grants without uninstalling its packages. A Run pins
the selected provider, connection identity, grants, tool/schema digests, and policy
epoch; credential rotation or catalog refresh cannot mutate an active snapshot.

**Scale and operations.** Catalog ingestion is bounded, incremental, resumable, and
idempotent. Enforce request/page/item/manifest/archive/decompression/time limits,
source-specific polling and rate limits, schema validation, URL/redirect policy, and
explicit stale/error states. Do not fetch executable payloads during search. Search
indexes only bounded metadata, never secrets or skill bodies. Record per-source
discovered/resolved/compatible/reviewed counts, duplicate/conflict counts, stale age,
last successful sync, and parse failures; alert on coverage loss instead of keeping
deleted or unavailable entries as current. Expansion from 500 to 1,000 is a catalog
quality/coverage target, not permission to weaken review or silently install items.

**AgentCowork relationship.** The catalog envelope, package/source identities, and
compatibility vocabulary are designed to be product-neutral. HorizonCode is the first
consumer; AgentCowork can later read the same catalog but keeps its own installations,
connections, credentials, grants, and runtime. A shared catalog does not make an
AgentCowork installer or connector runtime exist in HorizonCode, nor does it override
AgentCowork's local-first install and trust gates. Changes to this contract must be
made in HorizonCode first, reviewed, then mirrored into AgentCowork's owning LLD.

## 1. MCP servers (`CMP-mcp`)

**Config.** An `mcpServers` map with discriminated entries — `local` (`command`, `args`, `env`, `enabled`, `timeout`) or `remote` (`url`, `headers`, `enabled`, `timeout`). Scopes: `local` (this machine + project), `user` (all projects), `project` (committed, shared). Environment references expand (`${VAR}`) and MUST NOT embed raw secrets in committed files.

**Protocol/version.** The implementation baseline for this design is MCP `2025-11-25`; protocol revision and SDK version are pinned in fixtures before implementation. `initialize` is the required first lifecycle interaction for that version and negotiates protocol version/capabilities, followed by `notifications/initialized`. Capability discovery is performed by the corresponding list methods (`tools/list`, `resources/list`, `prompts/list`), not by treating `initialize` as catalog discovery. Streamable HTTP uses POST for client messages and may use GET for a server-to-client SSE stream; GET may be refused when no stream exists; responses may be JSON or SSE. The HTTP `MCP-Protocol-Version` header carries the negotiated revision on applicable later requests; it is not a duplicate of an invented body/header mirror. Legacy HTTP+SSE is not the selected transport. The 2026-07-28 revision is still a release candidate as of this document date; do not implement it as stable without rechecking the official status and compatibility fixtures. References: [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http).

**Transport.** stdio (client spawns the server; stdout carries protocol only, stderr is logs) and Streamable HTTP. Bind local servers to loopback and validate Host/Origin; remote HTTP requires supported authentication and TLS. Transport and lifecycle semantics are selected by the pinned protocol revision, not inferred from SDK naming.

**Discovery.** Cache results from the relevant list methods with TTL and refresh on `list_changed` (debounced). Capabilities come from `initialize`; list-method pagination and change notifications are separate contracts. Validate the negotiated version and applicable HTTP headers; do not invent body/header equality rules.

**Install/connect UX.** Search results describe candidate transports/packages only.
Before install, display source/version/digest/license, OS/package-manager requirements,
transport, requested credentials, and requested capabilities. Stage in an isolated
HorizonCode-managed location with bounded download/child-process resources. Then
configure environment secret references or complete supported OAuth, launch in a
disposable probe context, negotiate the protocol, list tools/resources/prompts, and
show the exact exposure. Only after separate explicit enable and tool-level policy
review are server capabilities materialized to a model. `installed`, `authenticated`,
`probed`, `enabled`, and `permitted` are distinct states. A missing auth field is not
equivalent to no-auth.

**Auth.** stdio uses process env credentials only. HTTP uses OAuth 2.1 with PKCE, resource indicators, and protected-resource metadata discovery; validate origin and bind local servers to localhost.

**Bridging.** Tools become namespaced native tools `mcp__<server>__<tool>`; names are unique per scope (duplicate server names fail fast). Bridged tools pass through `CMP-guard` like any tool and are permission-filtered at materialization. Pagination dedupes by a visited-cursor set with a hard page cap; tool lists are content-hash deduped.

**Large catalogs.** Discovery keeps a small searchable name/description index.
Full input/output schemas are fetched and selected on demand within the context
budget. Materialization pins catalog generation, selected schema digests and the
permission snapshot for one model step; an unselected or changed tool is refused
typed. This reduces prompt cost without allowing the model to bypass tool
registration or the guard (`REQ-CTX-010`).

**Lifecycle/status.** `connected | disabled | failed | needs_auth | needs_client_registration`. Reconnect uses bounded exponential backoff. A server that fails at startup does not abort the session (configurable); a failed refresh preserves the previously known tool set rather than dropping it.

**Avoid.** Unauth remote servers; blind auto-install from public registries; treating a registry listing as trust.

## 2. Skills (`CMP-config`)

**Format.** A skill is a directory containing `SKILL.md` with frontmatter (`name`, `description`, and optional `license`, `metadata`, and gating fields) plus an instructional body and optional `scripts/`, `references/`, `assets/`. Name must be lowercase kebab-case and match the directory.

**Discovery.** Current source accepts both `<root>/<name>/SKILL.md` and the legacy sibling `<root>/<name>.md` frontmatter form; see `crates/horizoncode-config/src/skills.rs` and AX-110. Preserve both in the initial migration or explicitly deprecate the sibling form with compatibility tests. The target canonical package is `<root>/<name>/SKILL.md`. Roots and lazy nested-root behavior are defined by the configuration LLD; do not claim watch-based reload until implemented.

**Routing — progressive disclosure, in tiers:**
1. **Catalog** — only `name` + `description` are resident in context, as a digest-diffed `available_skills` block.
2. **Body** — the full `SKILL.md` is injected once, on invocation (model-chosen by description or explicit `/name`).
3. **Resources** — referenced files and script output are loaded on demand; scripts run out-of-context and only their output is returned.

Gating fields: `disable-model-invocation` (user-only skills such as `/deploy`), `user-invocable: false` (model-only background knowledge), `paths` (glob scope), `context: fork` (run in an isolated sub-session), and `allowed-tools` (**an approval hint, never a sandbox**).

**Curator.** Enable/disable is stored in HorizonCode-owned config/lock state keyed by canonical skill identity and the discovered source digest. HorizonCode MUST NOT edit upstream or user-authored `SKILL.md` frontmatter to persist activation. A changed digest invalidates the old activation and requires review/re-pin; a lockfile pins externally sourced skills by version/hash. Discovery runs a quarantine scan; fetched sources are pinned before use, never trusted from a live index.

**Command identity.** A skill name that conflicts with a built-in remains invocable
through `/<source-kind>:<source-id>:<skill-name>` (for example
`/plugin:acme:login`); the built-in keeps `/login`. The source ID is a stable,
URL-safe registry identity, not a display label or load-order index. If one source
contains duplicate skill names, append canonical relative path segments in a stable
escaped form. Suggestions/help show the full key and source; any residual key
collision fails registration with both source identities and paths. Do not resolve
these collisions by load order. This exception applies only to skill invocation;
user command descriptor collisions remain registration errors (`DEC-080`,
`REQ-SKILL-005`).
`/skill` and `/skills` open this manager; they are not the route for executing a
selected skill. Explicit invocation resolves the registered source identity and
rechecks its content digest before loading the body. The upstream behavior reference
is Grok Build's pinned [`08-skills.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md)
(`SRC-031`; see [`ARCH/29` U-GROK-SKILLS](29-SOURCE-TRACEABILITY.md#u-grok-skills));
the deterministic identity and digest rules here are HorizonCode's design.

**Guided creation.** The Skills category's Create view provides the guided draft
wizard, reached from `/create-skill` (and `/skill create`) as a deep link into the
same Extensions surface. It asks for scope (project or user), canonical
name, description, and instruction body, and may add references/assets as explicit
draft files. Validate the name/directory relationship and frontmatter before showing
the exact file manifest and content preview. Creation is a guarded, auditable local
write through the existing configuration/filesystem owner; it MUST refuse to
overwrite an existing target. Cancel preserves the draft for the current UI flow but
creates no files. Create does not enable the new skill, trust project content, run
scripts, or make a skill model-invocable; activation remains a separate reviewed
action. Both create spellings open the same surface at Skills → Create, while `/skill`
without that subcommand remains manager navigation. The wizard is a
HorizonCode-owned design inspired by Grok's documented guided flow (`SRC-031`); see
the pinned upstream guide linked in **Command identity** above. No code is copied.

## 3. Plugins & hooks (`CMP-config`)

**Manifest.** A plugin directory with a manifest declaring name/version/description and component paths: skills, agents, hooks, MCP servers, LSP servers. Components are auto-discovered at conventional paths; the manifest overrides.

**Distribution/install.** Git-hosted marketplaces; install **copies** into a cache rather than linking; symlinks are resolved and verified so nothing escapes the plugin root. State that must survive updates lives under a data root, not the code root.

**Hooks.** Event → matcher → command. Hooks **tighten, never loosen** policy. Every hook invocation and outcome is logged (feeds `CMP-analytics` and `CMP-audit`). Command-only hooks are the v1 surface; richer hook kinds are gated behind an explicit capability.

**Trust.** Third-party and project plugins are **disabled by default** (`defaultEnabled: false`), require explicit enable, and pass allow/deny lists. Untrusted plugin processes and their MCP servers run under the sandbox profile. A managed lockdown can restrict which plugins/servers are permitted.

## 4. Peer agents over ACP (`CMP-acp`)

**Both roles are first-class** (`REQ-PROTO-004`, `DEC-019`): HorizonCode is driven by clients (editors) and drives peer agents as subordinates.

**Current source status at `23d4ce8` / source-map commit `cbba87b`:** the ACP crate is a
server-only v1 edge. It implements `initialize`, `session/new`, `session/prompt`,
`session/cancel`, `session/close`, streamed `session/update`, and
`session/request_permission`; it advertises only the implemented prompt capability.
It does not implement `session/load`, `session/resume`, `session/list`, `session/fork`,
an outbound ACP client, or a peer reconnect path. See `crates/horizoncode-acp/src/lib.rs`,
`server.rs`, and `ARCH/15`. The lifecycle/client behavior in this section is a target
contract, not current capability.

**Negotiation.** On `initialize`, exchange protocol version and capabilities; **every optional call is gated** by a negotiated capability — never assumed. Paths are absolute; keys are camelCase with snake_case discriminator values. Undefined behavior is added only through the `_`-prefixed extension mechanism, never as new root fields.

**Server role (target).** Advertise only methods implemented against the pinned ACP
wire schema and covered by conformance tests. HorizonCode intends to support the
required session lifecycle, streaming updates, permission requests, and usage only
where the selected protocol schema defines and negotiates them. `load`, `resume`,
`list`, `fork`, and `usage_update` are not currently advertised; `fork` remains
version-gated until stable.

**Client role (target).** Spawn a peer over stdio, keep one connection per worker
with its negotiated external session ID, forward supported permission/filesystem/
terminal/update requests through local policy and UI, and reconnect only when the
peer negotiates a supported resume mechanism. Outbound ACP client and reconnect are
absent at the current source baseline. A peer owns its own runtime, auth, model, and
native tools; HorizonCode forwards only explicitly selected workspace/services and
never merges configs silently.

**Permission policy** is evaluated for the HorizonCode Thread/Run authority snapshot and requesting peer identity, not inferred from an ACP `sessionId`. Where a remote peer requests permission, the prompt identifies that peer and its execution environment; where no elicitation UI exists, the exact request queues durably for the controller/operator and the effect waits.

## 5. Trust, provenance & lockdown

- Discovery ≠ trust. Enable is explicit; pins are version/hash-based; provenance is shown before enable.
- Allow/deny lists and a managed lockdown file gate MCP servers, plugins, and skills.
- No registry's own trust policy is inherited; HorizonCode defines its own.

## 6. Interfaces

| Component | Role |
|---|---|
| `CMP-config` | discovery roots, precedence, enable/disable, validation |
| `CMP-extension-catalog` | source adapters, normalized listing metadata, deduplication, bounded search, synchronization status, and compatibility evidence; no credential, installation, trust, or execution authority |
| `CMP-mcp` | server lifecycle, discovery cache, tool bridging, status |
| `CMP-acp` | capability negotiation, server + client roles |
| `CMP-guard` | policy gate for every bridged/hook/plugin effect |
| `CMP-sandbox` | confinement for untrusted plugin/server processes |
| `CMP-tui` / `CMP-headless` | show Connector/service, MCP, skill, plugin, hook, and workflow entries with typed status; interactive category routes share one overlay (`REQ-PROTO-007`) |

## 7. Failure modes

- Server crash → bounded reconnect, previous tool set preserved, status surfaced.
- OAuth expiry / needs-auth → explicit `needs_auth`, no silent retry storm.
- Duplicate server name → fail fast with a clear error.
- Skill digest change under pin → refuse until re-pinned.
- Plugin root escape via symlink → rejected at install.
- Hook that tries to loosen policy → refused.

## 8. Requirements mapping

`REQ-PROTO-003`, `REQ-PROTO-004`, `REQ-PROTO-006`, `REQ-PROTO-007`, `REQ-SKILL-001..005`, `REQ-PLUGIN-001..006`.

## 9. Open questions

- Exact MCP discovery wire shape across dated spec revisions.
- ACP schema v2 delta (`resume`/`close`/`additionalDirectories`) before implementation.
- SDK maturity outside the two primary languages.
- Skills curator lifecycle (usage-linked feedback, archive-not-delete) scope for v1.
