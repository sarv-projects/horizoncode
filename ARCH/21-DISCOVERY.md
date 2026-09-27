# 21 — Discovery & Extensions

How HorizonCode **detects, inspects, and uses** external capabilities: MCP servers, skills, plugins, and peer agents over ACP. Owned jointly by `CMP-mcp`, `CMP-config`, `CMP-orch`, and `CMP-acp`.

Default posture: **deny-by-default**. Nothing discovered is enabled, executed, or trusted merely because it was found. Discovery is cheap; use requires explicit enable, pinned provenance, and policy approval.

## 1. MCP servers (`CMP-mcp`)

**Config.** An `mcpServers` map with discriminated entries — `local` (`command`, `args`, `env`, `enabled`, `timeout`) or `remote` (`url`, `headers`, `enabled`, `timeout`). Scopes: `local` (this machine + project), `user` (all projects), `project` (committed, shared). Environment references expand (`${VAR}`) and MUST NOT embed raw secrets in committed files.

**Transport.** stdio (client spawns the server; stdout carries protocol only, stderr is logs) and streamable HTTP (one POST endpoint; the request-scoped SSE/JSON response). Legacy HTTP+SSE is **not** adopted.

**Discovery.** Query the server's stated capabilities through its discovery surface rather than assuming a handshake; cache the discovery result with a TTL and refresh on `list_changed` (debounced). Per-request metadata carries protocol version and client identity; HTTP headers mirror the body and MUST agree.

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

**Discovery.** One level only: `<root>/<name>/SKILL.md`. Roots: the user skills directory and the project walk from cwd up to the repository root, plus explicit extra directories and lazily-loaded nested roots on first file touch. Discovery is watched for live reload.

**Routing — progressive disclosure, in tiers:**
1. **Catalog** — only `name` + `description` are resident in context, as a digest-diffed `available_skills` block.
2. **Body** — the full `SKILL.md` is injected once, on invocation (model-chosen by description or explicit `/name`).
3. **Resources** — referenced files and script output are loaded on demand; scripts run out-of-context and only their output is returned.

Gating fields: `disable-model-invocation` (user-only skills such as `/deploy`), `user-invocable: false` (model-only background knowledge), `paths` (glob scope), `context: fork` (run in an isolated sub-session), and `allowed-tools` (**an approval hint, never a sandbox**).

**Curator.** Enable/disable is expressed in config and reflected back into SKILL.md frontmatter so state is portable; a lockfile pins externally sourced skills by version/hash. Discovery runs a quarantine scan; fetched sources are pinned before use, never trusted from a live index.

## 3. Plugins & hooks (`CMP-config`)

**Manifest.** A plugin directory with a manifest declaring name/version/description and component paths: skills, agents, hooks, MCP servers, LSP servers. Components are auto-discovered at conventional paths; the manifest overrides.

**Distribution/install.** Git-hosted marketplaces; install **copies** into a cache rather than linking; symlinks are resolved and verified so nothing escapes the plugin root. State that must survive updates lives under a data root, not the code root.

**Hooks.** Event → matcher → command. Hooks **tighten, never loosen** policy. Every hook invocation and outcome is logged (feeds `CMP-analytics` and `CMP-audit`). Command-only hooks are the v1 surface; richer hook kinds are gated behind an explicit capability.

**Trust.** Third-party and project plugins are **disabled by default** (`defaultEnabled: false`), require explicit enable, and pass allow/deny lists. Untrusted plugin processes and their MCP servers run under the sandbox profile. A managed lockdown can restrict which plugins/servers are permitted.

## 4. Peer agents over ACP (`CMP-acp`)

**Both roles are first-class** (`REQ-PROTO-004`): HorizonCode is driven by clients (editors) and drives peer agents as subordinates.

**Negotiation.** On `initialize`, exchange protocol version and capabilities; **every optional call is gated** by a negotiated capability — never assumed. Paths are absolute; keys are camelCase with snake_case discriminator values. Undefined behavior is added only through the `_`-prefixed extension mechanism, never as new root fields.

**Server role.** Advertise session lifecycle (new/load/resume/list/close/fork), streaming updates, permission requests, and `usage_update`. `load` replays full history; `resume` does not.

**Client role.** Spawn a peer over stdio, keep one connection per worker with its session id, forward the client handler set (permission, fs, terminal, updates) to the local UI/queue, and support reconnect via `resume`. A peer owns its own runtime, auth, model, and native tools; HorizonCode forwards only `cwd`, MCP servers, and fs/terminal services — it never merges configs silently.

**Permission policy** is per session and configurable (allow-all / deny-all / elicit / operator); where no elicitation UI exists, requests queue for the orchestrator to decide.

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
