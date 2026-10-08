# HorizonCode v1 architecture

**Status: FINALIZED TARGET — CANONICAL FOR HORIZONCODE V1 IMPLEMENTATION.** By explicit
user direction, this package is the self-contained normative architecture for the
OpenCode-derived HorizonCode v1 rebuild. The intended implementation base is the exact
pinned OpenCode source. The prior HorizonCode repository was initially preserved on
`legacy-horizoncode` / `pre-opencode-rebase`, but the user later directed that all prior
Git metadata be purged before initializing a fresh repository. Those local refs and
objects are gone; the P0 archive/provenance gate in [`10-DELIVERY.md`](10-DELIVERY.md)
is therefore **not satisfied**. Do not claim P0 completion or port old code without
independently recovering and verifying its source.

Finalizing the architecture does not claim that any v1 contract is implemented,
verified, accepted, or release-ready; it does not promote `TODO.md` rows, tests, or
acceptance records. The HLD/LLD contracts are organized across documents 01–18.
Unresolved capability decisions gate only the capabilities and claims listed in
[`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md); unrelated implementation may
proceed in dependency order under [`10-DELIVERY.md`](10-DELIVERY.md).

## Decision frame

The adopted v1 architecture uses the exact OpenCode revision below as the physical
starting point. `info.txt`, `info2.txt`, old `ARCH/` documents, research dumps and prior
conversation records are authoring provenance only. Their accepted requirements have
been reconciled into this package; none is required to understand or implement it, and
none remains an authority after cutover. The previous HorizonCode source was initially
preserved in Git, but its local refs and objects were removed during the fresh-Git reset.
Recover any source independently before considering a component for port through the
migration matrix in [`10-DELIVERY.md`](10-DELIVERY.md).

The adopted design uses an OpenCode-derived TypeScript/Bun host as the application,
and a Rust Horizon kernel as the authority. The kernel owns canonical Thread state as
well as managed Goal/Run/Task/Attempt state, effects, workspace fencing, recovery and
verification. The host retains the provider/runtime and UI substrate, but its session
database becomes a projection/compatibility source rather than a second conversation
authority. The Rust kernel is not a second model loop. The exact boundary is in
[`01-SYSTEM.md`](01-SYSTEM.md).

## Baselines

| Input | Revision / identity | Use |
|---|---|---|
| [OpenCode](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322) selected base | `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322` | Intended physical base; source files are present locally but ignored, and fresh `main` has no OpenCode-base commit yet; P0 base/provenance gate remains incomplete |
| HorizonCode legacy source | `5c20a65ee6c05c7771fbcbe1e2cde8fc192b8a34` (implementation seams inspected) | Local Git refs/object database were purged on 2026-10-08; historical evidence only until independently recovered; no selective port without source recovery and migration-matrix review |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) reference | `5badb15009ae1756c3afe0ae0cef1faafc290ccc` | Non-normative composition-pattern source; claims are bounded by the source map |
| `info.txt` / `info2.txt` | Historical proposal snapshots | Non-normative authoring provenance; not carried into active `main` and not required for implementation |

The proposal snapshots cite older OpenCode/HorizonCode revisions. Those citations explain
design provenance only; implementation claims use the exact source pins in this package.

The OpenCode tree is inventoried at path and line-count level. That mechanical inventory
is not a claim that every line received semantic review. The source-review coverage and
limits are recorded in [`09-SOURCE-MAP.md`](09-SOURCE-MAP.md), alongside the generated
path manifest. The domain vocabulary is in [`GLOSSARY.md`](GLOSSARY.md).

## Document map

1. [System, process, service, and ownership topology](01-SYSTEM.md)
2. [Domain model and schema overview](02-DOMAIN.md)
3. [End-to-end flows](03-FLOWS.md)
4. [Events, persistence, and recovery](04-STATE-EVENTS.md)
5. [Security, effects, and extension boundaries](05-SECURITY.md)
6. [OpenCode capability parity](06-CAPABILITIES.md)
7. [UI, CLI, and command surface](07-UX-COMMANDS.md)
8. [Reconciliation rationale and historical references](08-RECONCILIATION.md)
9. [Pinned source map and coverage limits](09-SOURCE-MAP.md)
10. [Implementation sequence and acceptance gates](10-DELIVERY.md)
11. [Canonical lifecycle and transition contracts](11-LIFECYCLE.md)
12. [Canonical domain schemas](12-DOMAIN-SCHEMAS.md)
13. [Service composition and host/kernel IPC](13-COMPOSITION-IPC.md)
14. [Effects, execution, security, and extension trust](14-EFFECTS-EXECUTION-SECURITY.md)
15. [Direct turns, context, repository intelligence, and managed work](15-RUNTIME-EXECUTION.md)
16. [UI, actions, settings, and extension ecosystem](16-UX-SETTINGS-ECOSYSTEM.md)
17. [Governance, reconciliation decisions, and open decisions](17-GOVERNANCE-DECISIONS.md)
18. [Operations, data lifecycle, performance, and release](18-OPERATIONS-RELEASE.md)
19. [Domain glossary](GLOSSARY.md)

## Governing invariants for adopted HorizonCode v1

- OpenCode-derived host code is the application/provider/UI base; the Rust Horizon
  kernel owns canonical Thread and managed-work truth.
- OpenCode remains the interactive provider/model/tool-loop substrate. The Rust kernel
  does not add a second model loop.
- OpenCode's existing Session SQL store cannot remain a second production conversation
  authority; session APIs are adapted to the kernel-owned Thread service.
- The Horizon kernel is the only managed Run/Task/Attempt lifecycle authority.
- `ThreadId`, provider Turn, Run, Task, Attempt, and WorkerExecution are distinct identities.
- Every effect-capable OpenCode tool crosses the same Horizon authorization and
  settlement boundary before dispatch; exceptions are declared as trusted/unmediated,
  never silently described as governed.
- A worker's result, session completion, process exit, or UI status never means
  `Task PASS`; only independent, revision-bound verification can produce qualifying
  evidence.
- OpenCode's native capability surface is retained or explicitly listed as an open
  parity gap. Hosted service behavior is not silently represented as locally available.
- Host and kernel exchange typed, bounded, versioned private RPC. Neither process
  writes the other owner's state store.
- Host features compose through typed service definitions and pinned generations;
  production canonical authority services are sealed, and third-party executable
  extensions do not run with unrestricted host authority.
- Uncertain provider, process, effect, and launch outcomes remain `UNKNOWN` until
  reconciled; no blind replay is permitted.
- The logical domain envelope and physical event-log record are separate contracts;
  the existing Horizon segmented committed-head event log is the persistence seam,
  not a reason to create a parallel format. See [§4](04-STATE-EVENTS.md) and the
  [current-source ledger](09-SOURCE-MAP.md).
- Platform readiness, OpenCode parity, security enforcement, and release acceptance
  require revision-bound evidence; architecture adoption establishes none.
