# Performance contract

## Measurement boundaries

All figures are target budgets, measured on a named reference machine, OS, terminal, build and local deterministic provider fixture. Report cold/warm state and sample count/percentiles. Do not present provider/model/network latency as harness overhead or subtract it from user-visible total latency.

| Metric | Start → end | Target / required reporting |
|---|---|---|
| PERF-INPUT | Key/paste admitted → visible feedback | p95 ≤50 ms; include extraction/background load |
| PERF-PROMPT | Warm invocation/resume → usable composer | p95 ≤300 ms; required authority may still block dispatch visibly |
| PERF-STARTUP | Warm binary invocation → initialized session/core service | ≤600 ms legacy startup budget; report separately from composer readiness; cold distribution also required |
| PERF-DISPATCH | Warm admitted input → provider dispatch | harness-only p95 ≤50 ms excluding explicit policy waits/fsync/network; inclusive durable-admission latency also required |
| PERF-STREAM | Received eligible stream delta → painted | p95 ≤100 ms; no artificial typing delay |
| PERF-FRAME | Active UI frame CPU work | p95 ≤8 ms; complete render/frame elapsed ≤16 ms budget, measured separately |
| PERF-MOTION | Selection/overlay transition and active repaint cap | Selection feedback 80–140 ms; overlays 120–180 ms; active rendering capped at 30 FPS. Transitions are interruptible; reduced/off motion presents the final state immediately. |
| PERF-CANCEL | Cancel ingress → visible durable/request acknowledgement | p95 ≤100 ms; actual process/effect settlement separately reported |
| PERF-E2E | Submit → first meaningful result and verified completion | report provider/model/network/tool wait, model rounds, verification cost and result correctness; no invented universal inference target |
| PERF-MANAGED | Ready controller transition → dispatched eligible work | report queue, locking, persistence and orchestration overhead under concurrent load |
| PERF-IDLE | No visible/active work | no periodic animation wakeups; report CPU/RSS and legitimate background jobs separately |

## Fast path

UI readiness does not wait for optional VCS, index, MCP, skills or extension catalog discovery. Mandatory policy/configuration/instructions must validate before effects or provider egress. Persistent services reuse initialized runtime state without automatically starting a detached daemon or listener. Optional discoveries apply at safe epochs; live narrowing immediately fences new effects.

Authorized deterministic commands, file completion and fresh intelligence queries run locally under finite bounds. Free-form intent still requires reasoning; lexical matches are not semantic references. Parallelize only independent operations with bounded pools; conflicts and unknown scopes serialize. Stable provider-supported context prefixes reduce redundant processing without granting cached data authority. Cache hits are observed provider facts, not inferred promises.

## Load and regression fixtures

Measure 100k-message paged history, 10k-line paste, Unicode/IME, resize, slow terminal, concurrent output, delayed optional initialization, control saturation, memory extraction, index invalidation and remote/stub backpressure. Record CPU/RSS, frame time, lag, queue wait, fsync, first byte, model/tool rounds and replay time. Include correctness, stale-result prevention and verified task success; a faster incorrect result fails acceptance. Replay does not replay animations, and reduced-motion/monochrome fallbacks preserve status and control.

Additional deterministic workloads use these targets on a named release-build reference machine, with sample counts and cold/warm conditions recorded:

| Measurement | Target and workload |
|---|---|
| Warm startup to interactive prompt | p50 ≤250 ms and p95 ≤600 ms with warm index/catalog cache, synthetic 200-file repository, no network |
| Cold offline startup | p50 ≤700 ms with catalog enrichment disabled and no network |
| Tool-output capture decision | p95 ≤20 ms for a 50 MiB streamed capture; this is capture processing time, not subprocess duration |
| Incremental repository-map rebuild | p95 ≤250 ms for a change of at most 50 files; rebuild never blocks the agent loop |
| Audit verification | ≤2 s per 100k entries for a full local chain |
| Session replay | ≥10k events/s, single-threaded |
| Memory use | Per-Thread and per-subsystem ceilings are declared and asserted in an eight-hour bounded-workload soak |

ACP initialization-to-ready uses the warm startup bound. Full-frame redraw remains ≤16 ms p95; a 100k-line transcript touches only visible rows and the mutable tail. These targets are budgets for acceptance, not observed product measurements. If a target conflicts with correctness, input responsiveness, or durable effect ordering, the acceptance record reports the miss; it does not weaken those contracts.

Numerical performance budgets are defined only here. Test cases and settings link to these metrics; they do not introduce alternate thresholds.
