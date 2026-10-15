# HorizonCode resource and execution measurement runbook

**Status:** operational evidence template / not normative architecture. Requirements: [§18.17](../../arch_V1/18-OPERATIONS-RELEASE.md), [§32.32](../../arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md), implementation gates in [the current plan](../superpowers/plans/2026-10-11-horizoncode-converged-implementation.md). **No HorizonCode-vs-JCode benchmark has been run by this document.**

## Baseline setup

Pin HorizonCode exact commit, JCode exact commit/version, OS/kernel, native Windows versus WSL, CPU model, physical RAM/swap, disk, runtime versions, release/debug build, compiler flags, allocator and renderer settings. Use the same checkout/task fixture, provider, selected model, tool availability, auth mode, temperature, local inference/embeddings settings and external connection conditions. Report provider-side variability separately, never as local agent time.

Evaluate 1, 5, 10 and 20 Sessions with each of: (a) cold startup + time to first usable frame/input; (b) steady idle after 2 minutes; (c) five model turns with read/list/search/tool output and a real small edit in isolated test workspaces; (d) 30-minute idle; (e) steady active workload with bounded build/test jobs; (f) teardown and leak slope. Repeat each configuration at least three times and retain raw samples and variability rather than asserting exact competitive ratios. Label whether the configuration includes **all descendant processes** and local model runtime (also record agent-only subset). Never give JCode credit for a proposed-only feature.

## Metrics and units

| Column | Source | Rule |
|---|---|---|
| agent_process_tree_pss_mib | Linux per-PID `/proc/<pid>/smaps_rollup`, group all descendants | Measured PSS; do not conflate with RSS or include provider server ambiguously |
| agent_process_tree_rss_mib | Linux `/proc/<pid>/status` / process metadata | Measured but shared pages double-count across processes |
| private_dirty_uss_mib | Linux smaps private pages | Label coverage and method |
| windows_private_bytes_mib | Windows native performance counters | Do not compare directly with PSS |
| mac_physical_footprint_mib | macOS task/process APIs | Record collection method |
| cpu_percent, threads, fd_count | OS process tree | Record percent denominator and per-owner aggregate |
| heap/allocator/cache_bytes | Runtime-owned counters | Keep source, logical vs resident and estimated/unknown separate |
| local_model_ram_vram_mib | Inference process/GPU vendor tool | Distinguish shared external model from host and show inclusive total |
| first_frame_ms, first_input_ms, input_p50/p95_ms | Instrumented UI | Eliminate auth/provider idle startup differences |
| full_frame_repaints, redraw_reason, idle_cpu | UI event/paint traces | 30-minute idle should not repaint continuously |
| tool_tail_bytes, history_bytes, artifact_bytes | Session/store/render owners | Cap ephemeral duplicates, preserve FULL/SAMPLE provenance |
| process_tree_pids, active_workers, worktrees, target_build_bytes | Resource owner/supervisor | Include owned child processes/port/build outputs |
| task_pass_rate, verification, unsafe_effect_count | Deterministic fixture + final revision checks | Performance gain is invalid when correctness or isolation regresses |

Report **unknown** when a platform/counter is not available; never replace with `0`. Keep raw JSONL/CSV and renderer/OS logs redacted under `docs/performance/evidence/` only after actually running; do not commit API keys, prompts, captured stdout or real user paths.

## Comparison and gate

1. Baseline current per-session Rust supervisor and existing OpenCode-derived host.
2. Instrument per-session parent/child/process-tree owner attribution with bounded overhead.
3. Prototype shared **read-only** SessionLink service behind the existing host service; compare with baseline under identical tests.
4. Prove cross-session adversarial scopes, request fairness and crash/replay before any effectful shared-kernel cutover.
5. Compare after adding memory caps, lazy provider/client pools, headless-worker reuse, adaptive renderer and file-touch index **one change at a time**; record correctness and resource deltas independently.
6. Set measured per-OS release budgets/ratchets from raw data; an initial >10% median 10-session PSS increase may be investigated but is *not an official existing limit*. Preserve a rollback path.

JCode public comparison sources (external, **not independently confirmed results**): [README](https://github.com/1jehuang/jcode/blob/1f612a7/README.md), [memory budget](https://github.com/1jehuang/jcode/blob/1f612a7/docs/MEMORY_BUDGET.md), [benchmark script](https://github.com/1jehuang/jcode/blob/1f612a7/scripts/bench_headless_memory.py).

## Empty evidence record example

```json
{
  "status": "NOT_RUN",
  "product": "horizoncode",
  "git_commit": null,
  "os": null,
  "machine_id_redacted": null,
  "build_profile": null,
  "scenario": "JC-RES-001",
  "sessions": 10,
  "selected_provider_and_model": null,
  "inference_memory_included": null,
  "observations": [],
  "known_limitations": ["No measurements taken"]
}
```

Do not generate a fake success report from this template. Benchmark harness scripts and CI ratchet are **outstanding implementation tasks**.
