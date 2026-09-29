# 21 — Discovery & Extensions

How HorizonCode **detects, inspects, and uses** external capabilities: MCP servers, skills, plugins, and peer agents over ACP. Owned jointly by `CMP-mcp`, `CMP-config`, `CMP-orch`, and `CMP-acp`.

Default posture: **deny-by-default**. Nothing discovered is enabled, executed, or trusted merely because it was found. Discovery is cheap; use requires explicit enable, pinned provenance, and policy approval.

## Extension manager and registry UX

`/mcp`, `/skills`, and `/plugins` open the same centered extension-manager overlay,
with three top-level tabs: **Search**, **Installed**, and **Create**. Search covers the
official MCP Registry for MCP metadata plus a small HorizonCode-curated list that
records independent review and compatibility evidence. The official registry is a
discovery/index service, not an installer, code-signing authority, security verdict,
or source of HorizonCode trust. Catalog records are inert, bounded, schema-validated
metadata with publisher/source/version/license/transport/auth/provenance fields. A
catalog refresh never changes an installed artifact or active Run. See the official
[MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md).

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

The **Installed** tab groups MCP servers, skills, and plugins by enabled/disabled,
needs-auth, failed, stale, or quarantined status, showing provenance pins and recent
health. **Create** starts a local MCP config, skill package, plugin bundle, or workflow
template wizard; it validates and previews files before writing. Project-sourced
definitions remain untrusted data until user trust and policy permit their use.

Implementation phases: start with the official Registry's read-only metadata API and
HorizonCode-local curated catalog; ship no general open upload/publish service in v1.
Add user/team catalogs later as user-controlled Git/HTTP sources under the same
metadata-only rules. This avoids operating a new registry while preserving a stable
catalog adapter and provenance model.

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

## 3. Plugins & hooks (`CMP-config`)

**Manifest.** A plugin directory with a manifest declaring name/version/description and component paths: skills, agents, hooks, MCP servers, LSP servers. Components are auto-discovered at conventional paths; the manifest overrides.

**Distribution/install.** Git-hosted marketplaces; install **copies** into a cache rather than linking; symlinks are resolved and verified so nothing escapes the plugin root. State that must survive updates lives under a data root, not the code root.

**Hooks.** Event → matcher → command. Hooks **tighten, never loosen** policy. Every hook invocation and outcome is logged (feeds `CMP-analytics` and `CMP-audit`). Command-only hooks are the v1 surface; richer hook kinds are gated behind an explicit capability.

**Trust.** Third-party and project plugins are **disabled by default** (`defaultEnabled: false`), require explicit enable, and pass allow/deny lists. Untrusted plugin processes and their MCP servers run under the sandbox profile. A managed lockdown can restrict which plugins/servers are permitted.

## 4. Peer agents over ACP (`CMP-acp`)

**Both roles are first-class** (`REQ-PROTO-004`): HorizonCode is driven by clients (editors) and drives peer agents as subordinates.

**Current source status at `23d4ce8` / HEAD `cbba87b`:** the ACP crate is a
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
| `CMP-mcp` | server lifecycle, discovery cache, tool bridging, status |
| `CMP-acp` | capability negotiation, server + client roles |
| `CMP-guard` | policy gate for every bridged/hook/plugin effect |
| `CMP-sandbox` | confinement for untrusted plugin/server processes |
| `CMP-tui` / `CMP-headless` | enumerate detected servers/skills/plugins with status (`REQ-PROTO-007`) |

## 7. Failure modes

- Server crash → bounded reconnect, previous tool set preserved, status surfaced.
- OAuth expiry / needs-auth → explicit `needs_auth`, no silent retry storm.
- Duplicate server name → fail fast with a clear error.
- Skill digest change under pin → refuse until re-pinned.
- Plugin root escape via symlink → rejected at install.
- Hook that tries to loosen policy → refused.

## 8. Requirements mapping

`REQ-PROTO-003`, `REQ-PROTO-004`, `REQ-PROTO-006`, `REQ-PROTO-007`, `REQ-SKILL-001..004`, `REQ-PLUGIN-001..004`.

## 9. Open questions

- Exact MCP discovery wire shape across dated spec revisions.
- ACP schema v2 delta (`resume`/`close`/`additionalDirectories`) before implementation.
- SDK maturity outside the two primary languages.
- Skills curator lifecycle (usage-linked feedback, archive-not-delete) scope for v1.
