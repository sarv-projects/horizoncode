# Capabilities

## CapabilityRecordV1

`{schema_version, capability_key, description, owner, port, subject_id, build_digest?, platform, required_inputs[], dependencies[], security_tier, configuration_digest, trust_snapshot_ref?, availability: AVAILABLE | UNAVAILABLE | DEGRADED | BLOCKED | UNKNOWN, unavailable_reason?, observed_at, expires_at?, evidence_refs[], limitations[]}`.

Keys are Horizon-owned (`tools.lsp`, `workspace.worktree`, `artifact.preview.svg`), independent of vendor command labels. Availability is a runtime observation. Implementation, verification and acceptance are delivery evidence maintained in TODO/test records; a configured but unavailable capability cannot look ready. Unsupported and unknown are distinct from an empty successful result.

## Ownership and query

The `owner` is the canonical component that produces the record and owns its source
observation, evidence references, and availability transition. No component may write
or upgrade another owner's record. A cross-component capability listing is a
read-only, revision-stamped projection of those owner records; it has no independent
durable truth and cannot authorize dispatch. The owner revalidates availability and
required inputs at use time. A catalog entry, configured integration, or peer report
alone cannot produce `AVAILABLE`.

## Capability packs

Packs are finite declarative compositions of verified-compatible tools, skills and checks: `{pack_id, version, member_refs[], compatibility_requirements[], source_digest}`. Each member retains its own trust and policy checks. A pack cannot grant authority, run installation hooks, start another runtime or override per-member enablement.

## Discovery and replacement

Catalog metadata and competitor documentation establish only sourced observations. They cannot enable calls or establish HorizonCode parity. Renderer, clipboard, Code Mode and extension-manager availability are negotiated independently. Refresh is explicit or an authorized bounded metadata job; it cannot send repository data, install code or start costly probes by implication.

Adapter replacement is accepted through contract tests showing that lifecycle, authorization, receipts, evidence and recovery retain their meaning. Configuration, migration and capability losses must be disclosed. Peer comparisons, adoption decisions and source links live in research.
