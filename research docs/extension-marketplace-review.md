# Extension marketplace and Connector strategy

Research checked 2026-09-30. This note records current public behavior and the
HorizonCode design derived from it. It is not evidence that HorizonCode has a
marketplace, Connector runtime, or a catalog of any size.

## Recommendation

Build one **shared catalog**, with HorizonCode as the first consumer and AgentCowork
as a later consumer. The catalog is a source-aware index over existing ecosystems,
not a project to author hundreds of integrations and not a service that executes
packages. Keep the consuming product's installer, credentials, permissions, and
runtime local to that product.

Use four top-level listing families:

1. **Connectors / services** — the user-facing “Connect GitHub / Slack / PostgreSQL”
   destination. This represents the service and the capabilities people want. Search
   can present a recommended provider and alternatives.
2. **MCP servers** — concrete local or remote MCP packages/endpoints. A server may
   implement one Connector service; it stays an implementation option under that
   service and is also directly discoverable in the MCP category for users who want
   to configure the server themselves.
3. **Skills** — Agent Skills-format instruction/resource folders with a source,
   revision, digest, and compatibility report.
4. **Plugins** — installable bundles of skills, MCP declarations, agents, hooks,
   assets, and documented host-specific components. A bundle is one listing;
   components are not counted again unless separately published.

Hooks and workflows are component or native HorizonCode categories in the shared
Extensions UI, but they are not independent public-market listing families in the
initial count. This avoids presenting arbitrary scripts as an ordinary safe package.

## The 500–1,000 goal

The product goal is **at least 500 unique, source-resolvable listings at the first
broad release**, then **1,000** as the catalog grows. This is a catalog-coverage
goal—not 500 native implementations, not 500 audited packages, and not a claim about
current upstream totals. The counted record must have a canonical type-qualified ID,
a source the client can still resolve, a last-checked time, and enough bounded
metadata to identify its publisher/source and package/service. The acceptance gate
requires a real dated snapshot, not estimates or mocked count fixtures.

Working planning mix for the first 500 entries:

| Family | Planning floor | Main coverage |
|---|---:|---|
| Connector/service listings | 200 | Developer services first, plus general-work services for the shared market |
| Standalone MCP server listings | 150 | Official Registry entries and user/curator-selected sources |
| Skill packages | 100 | Curated/selected Git sources using the open Agent Skills folder format |
| Plugin bundles | 50 | Curated and documented Git marketplace formats |
| **Total** | **500** | Unique counted listing identities, with per-family/source reporting |

These are planning floors for catalog work, not permission to ingest low-quality or
unresolvable records. If a family cannot meet its floor without weakening source,
deduplication, or compatibility evidence, report the shortfall and revise the rollout
plan explicitly. A provider offer, plugin component, alternate version, marketplace
mirror, or similarly named record never fills a family quota by itself. At 1,000,
expand the same families and add org/private catalogs only through an explicit source
configuration and policy.

## Which service categories to cover

HorizonCode is the first consumer, so rank software-development work first:

- Source control and code review: GitHub, GitLab, Bitbucket.
- Issues, project tracking, docs and knowledge: GitHub Issues, Linear, Jira, Azure
  DevOps, Confluence, Notion.
- CI/build/test: GitHub Actions, GitLab CI, Jenkins, CircleCI, build/test result APIs.
- Deployment and cloud: Vercel, Netlify, Cloudflare, Railway, Render, AWS, Azure,
  GCP, Kubernetes.
- Databases and backend platforms: PostgreSQL, MySQL, MongoDB, Redis, Supabase,
  Firebase, Neon.
- Production health/security: Sentry, Datadog, Grafana, vulnerability scanners,
  dependency and code-security services.
- Design/API/package infrastructure: Figma, API clients, npm, PyPI, crates.io and
  container registries.
- Team communication used in engineering: Slack, Microsoft Teams, email/calendar
  services where a specific workflow requires them.

The shared catalog can also list general-work services for AgentCowork: email,
calendar, cloud files, office documents/sheets/slides, CRM, customer support,
research, analytics, finance/business systems, HR, marketing, and enterprise
knowledge systems. HorizonCode may search them but should rank code-work services
first. Catalog membership does not imply a service has a native implementation or is
usable on both hosts.

## Source plan: ingest, adapt, curate

### MCP servers

Use the official MCP Registry read API as the first wide source. It provides cursor
pagination, latest/version lookup, `updated_since`, and deletion-aware incremental
sync. Its built-in name search is intentionally simple; the Registry documentation
directs advanced search to subregistries. Keep a synchronized metadata index, record
upstream status and synchronization time, and add HorizonCode-owned search,
compatibility, and review metadata. Registry publication is not HorizonCode approval.

Allow direct user-provided Git/local sources and remote endpoints through the staged
installer. Do not auto-install from a registry search result. A listing stores a
pointer to the upstream package/version; the installer resolves and pins the payload
only after review.

### Skills

Adopt the open Agent Skills package convention: a directory centered on `SKILL.md`,
with optional scripts, references, and assets. There is no single authoritative
global skills registry established by this research, so federate explicit Git/local
sources and maintain a curated source list. Search indexes only bounded metadata;
body and resources load on activation. Treat skill instructions as untrusted input,
and treat scripts as executable code requiring separate Guard/Sandbox handling.

### Plugins and marketplace formats

Implement format adapters, not one adapter for every individual plugin:

- OpenAI/Codex documents a portable Agent Plugins package with root `plugin.json`,
  optional `skills/`, `mcp.json`, hooks/assets, plus surface-specific configuration
  under a vendor extension namespace. Codex local/repository marketplaces can be Git
  or local directories. This does not prove every package works identically across
  Codex and other hosts.
- Claude Code marketplaces use a Git directory/repository with
  `.claude-plugin/marketplace.json` pointing to plugin package sources; plugins can
  bundle skills, agents, hooks, and MCP servers. Claude's hosted plugin directory is
  a separate destination from user-added Git marketplaces.
- Grok Build documents configurable Git marketplace sources and plugins containing
  skills, agents, hooks, MCP and LSP components. It documents Claude Code file/source
  compatibility, but that does not make its hosted Grok connector catalog a Grok
  Build plugin marketplace.

Preserve original manifests. Parse documented fields and report each component as
supported, partially supported, ignored, or rejected by HorizonCode. Do not promise
“full compatibility” merely because the manifest parses. Only index public,
documented, publisher-authorized, or user-selected sources; do not scrape closed
vendor directories.

### Connectors

Maintain service records separately from implementation offers. For example:

```text
GitHub service
  ├── official remote MCP offer
  ├── community/local MCP offer
  ├── future native HorizonCode offer
  └── future gateway offer, only after a separate product/security/cost decision

Connection
  └── one user's or organization's authorized GitHub account + scoped grants
```

Start with curated service listings and official MCP/provider references where
available. Do not commit to Nango, Composio, Pipedream, Zapier, or another gateway in
the catalog contract. A gateway is one possible provider adapter; before use, review
where requests and credentials flow, data retention, billing, terms, scopes, and
outage behavior. Build native connectors only when a measured product need justifies
the maintenance cost.

## Catalog data and lifecycle

Keep separate records for:

- `CatalogEntry`: stable type-qualified listing identity and descriptive metadata.
- `SourceRecord`: each source, upstream ID/location, revision/version, digest when
  available, sync time, and source status. Preserve mirrors as provenance.
- `ProviderOffer`: concrete MCP/native/gateway implementation for a Connector
  service; not another service or account.
- `Installation`: package copied/pinned in one product's install root and scope.
- `Connection`: authenticated account binding in one product, with secret references
  owned by that product's `CMP-secrets`/AgentCowork vault.
- `Capability` and `Grant`: what an implementation can do and what the user/policy
  permits it to do. Discovery metadata never grants a capability.
- `CompatibilityEvidence`: host, version, platform, checks, timestamp, and status.

Deduplicate only with a strong canonical identity (publisher/source ID, upstream
canonical package identity, or identical immutable digest). Similar names are not
enough. Keep conflicts separate and show related records. Versions and alternate
providers are child records; bundle components do not add to total count unless
independently published.

Show these independently: listed, source-resolvable, format-compatible,
host-compatible, probe-passed, security-reviewed, publisher-verified, official, and
enabled. Each badge requires scoped, dated evidence; stale evidence expires visibly.
Do not collapse these into “verified.” Search prioritizes resolvable, host-compatible
items while allowing explicitly labeled candidates.

For the user, the first action is simple: **Connect [service]**. Keep provider choice,
scopes, server configuration, probe output, permission detail, provenance and source
format behind focused detail/review. Installed package, authenticated Connection,
profile enablement, and use in a Run are separate states. A disconnect removes the
product-local credential reference/grants but does not uninstall a plugin or MCP
package. Runs pin the provider, Connection ID, grants, tool/schema digests, and policy
epoch; refreshing the catalog cannot alter an active Run.

## Operational plan

1. Define and version the listing/source/evidence contracts; retain the original
   source manifest and unknown fields.
2. Build read-only MCP Registry sync, bounded metadata search, dedup/conflict status,
   and source freshness/deletion handling.
3. Add Agent Skills and Git marketplace source adapters; build compatibility reports
   before installation support.
4. Add Connector/service cards with provider offers and product-local Connection
   flows through the owning secret/Guard/runtime services.
5. Add curated seed records and count coverage by source/family toward the 500 floor;
   expand toward 1,000 with dated, source-resolvable snapshots.
6. Add private/team catalogs and hosted publishing only after source identity,
   signatures/digests, revocation, abuse handling, update review, and rollback design.

Catalog sync is bounded, incremental, resumable, and idempotent. Search does not
download or execute payloads. Limit pages, items, manifest/archive size, redirects,
decompression, time, retries, and source request rate. Show stale/partial/error state;
do not leave deleted/unreachable sources looking current. Track counts, duplicate and
conflict rates, parse errors, stale ages, and compatibility review coverage.

## Source review and limits

| Source | What it documents | HorizonCode use |
|---|---|---|
| [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) | Portable Agent Plugins manifest/package structure, Git/local marketplace sources, Codex-specific overlay and limits | Package-format/source adapter evidence; do not assume universal runtime compatibility |
| [Claude Code plugin overview](https://code.claude.com/docs/en/plugins) and [marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces) | `/plugin` discovery from official and user-added marketplaces; Git catalog manifests and plugin component bundle | Git marketplace adapter and progressive component inventory; no private hosted-directory scraping |
| [Grok Build skills/plugins/marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces) | Skills and plugin components; configurable marketplace sources; shared extensions UI; Claude compatibility claim | UI/source adapter pattern; treat compatibility as a per-component report |
| [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers) and [hosted connectors](https://docs.x.ai/grok/connectors) | Build-side MCP configuration/UI differs from cloud-hosted OAuth and catalog connectors | Keep package marketplace distinct from Connector/service catalog and account Connection |
| [Official MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md) | Cursor pagination, search by name, versions, incremental `updated_since`, deletion inclusion, detail lookup | Read-only metadata sync; add our own search and trust/compatibility evidence |
| [Agent Skills specification](https://agentskills.io/specification) and [repository](https://github.com/agentskills/agentskills) | Open folder format with `SKILL.md`, metadata/instructions and optional resources/scripts | Standard skill package format; no authoritative global package marketplace claim |

Codex and Anthropic publish product documentation, not complete private product source
implementations. xAI's public Grok Build repository is a periodically synchronized
snapshot; public docs can describe product behavior not present in that snapshot.
Registry and vendor docs are mutable, so recheck them before implementing an adapter.
This research did not enumerate, download, test, or certify 500 real listings. It
defines the acquisition and verification path and the acceptance evidence required
before claiming that target.
