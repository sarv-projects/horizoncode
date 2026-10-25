# Provider layer — standalone SDK map

Status: implementation map, not architecture authority. Normative owners are
`arch_V1/17-GOVERNANCE-DECISIONS.md` (A-V2-27 amendment, 2026-10-23),
`arch_V1/20-OPENCODE-INTEGRATION-LLD.md §20.16`, and
`arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` SRC-027/SRC-028.

The provider list, credentials/login and per-vendor connection recipes are consumed from the
OpenCode provider layer as a library. HorizonCode is the consuming product, using these providers
through the SDK; `opencode` (OpenCode Default) and `opencode-go` (OpenCode Go) remain explicit
provider identities with their service eligibility and access outcomes intact.

## Pinned source

- Pinned revision: `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322` (see §42).
- Fetched update candidate (awaiting adoption): `43868389223f3553c6786c2f1cfa70a657f8a8bf` (2026-10-23).
- Never update one file in isolation. Apply the procedure below and record the new pin in §42 first.

## File map

| Local file | Upstream path at pin | Decision / Horizon delta |
|---|---|---|
| `provider.ts` | `packages/opencode/src/provider/provider.ts` | REUSE registry, bundled adapters, display identity; ADAPT anonymous eligibility, managed-route projection, and unknown-not-affirmative capability/cost defaults (absent `tool_call`/modalities → `false`, absent price components → unknown/AN-002, empty provider registry → `NoProvidersError`) |
| `transform.ts` | `packages/opencode/src/provider/transform.ts` | REUSE |
| `error.ts` | `packages/opencode/src/provider/error.ts` | REUSE |
| `doctor.ts` | n/a — no `provider/doctor.ts` exists at pin `b1fe25a` (or any available upstream ref) | Horizon-owned offline projection; full/network tier only after explicit authorization and Guarded capability (§32 PD rows) |
| `auth.ts` | `packages/opencode/src/provider/auth.ts` | ADAPT: provider auth facade over Horizon credential ownership |
| `model-status.ts` | `packages/opencode/src/provider/model-status.ts` | ADAPT: status/freshness projection, advisory only |
| `digitalocean-catalog.ts` | n/a — no upstream DigitalOcean source exists at pin `b1fe25a`; the retained adapter lineage lives in local `provider.ts` | ADAPT: cached catalog projection only — no plugin initialization, token refresh, credential mutation or network access |
| `../auth/index.ts` | `packages/opencode/src/auth/index.ts` | ADAPT: login/OAuth/device/API-key recipes; writes stay behind protected input + SecretBroker |
| `../auth/provider-transport.ts` | upstream call shape only | Horizon hardening: exact route match, forbidden credential headers rejected, bounded body/response, possible-send UNKNOWN, no replay; plus the §30.26.9 read-only route `prefixCacheSupport` capability and context-compile `catalogSnapshot` projection (no dispatch change) |
| `../auth/secret-broker.ts` | n/a (Horizon-owned) | leased/versioned/revocable credential use |
| `../auth/secure-input.ts` | n/a (Horizon-owned) | protected native credential input boundary |
| `../../../core/src/models-dev.ts` | `packages/core/src/models-dev.ts` | ADAPT: metadata catalog, provenance sidecar, startup `refresh()` with last-known-good cache fallback |
| `../../../core/src/plugin/models-dev.ts` | `packages/core/src/plugin/models-dev.ts` | ADAPT: one bounded startup refresh attempt + catalog/integration reload on `Refreshed` |
| `../../../core/src/session/provider-request.ts` | n/a (Horizon-owned) | exact `DirectProviderRouteProjectionV1` match |

## Non-negotiable invariants

- One provider/credential source. No second catalog, credential store or route authority.
- Models.dev metadata is advisory only (models, costs, consumption, capabilities). It cannot enable a
  route, prove endpoint health/free entitlement, or change the user-selected provider/model/harness.
- Direct dispatch is fail-closed: exact route projection, SecretBroker lease, no environment/legacy
  credential bytes, bounded transport, UNKNOWN on possible send, no hidden paid fallback.
- Startup metadata refresh is one bounded attempt per process start; stale/offline keeps the last
  known-good snapshot and reports freshness instead of blocking session start.

## Update checklist

1. Fetch the target upstream revision; record it in `arch_V1/42` before editing local source.
2. Diff every file in the map plus its imported callees, schemas and tests at the same commit.
3. Classify each change REUSE / ADAPT / ADAPTER / REJECT; do not replace a hardened Horizon boundary
   with upstream wholesale.
4. Re-apply Horizon hardening where an upstream file is replaced (transport bounds, route projection,
   SecretBroker, Guard, offline Doctor).
5. Update this map and the §42 pin.
6. Run the provider/auth/models-dev focused suites and P6-PROVIDER-001..004 on the exact diff.
7. Update status only with observed evidence; a mapped file is not a working feature.
