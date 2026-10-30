---
name: performance-profile
description: Use when performance must be measured: form a hypothesis, benchmark before and after, isolate the hotspot, change one thing per measurement, and report numbers not vibes.
---

# Profile Performance (builtin.performance-profile)

Measure before and after with the same workload and report numbers, not impressions.
Form a hypothesis, isolate the hotspot with a real profiler or benchmark, change
one thing per measurement, and prove correctness still holds. In a direct session
the profile informs a fix; in a managed run it is the acceptance evidence for a
performance task.

## When to use

- A performance regression is reported or suspected.
- A hot path, large query count, or slow startup must be improved.
- A change claims to be faster and needs proof before merge.
- A budget (latency, memory, bundle size) must be verified before release.

## Workflow

1. Define the metric and the workload: latency p50/p95, throughput, allocations,
   peak memory, or bundle bytes — plus a reproducible input that drives it.
2. Capture the baseline with a real command: the repo benchmark suite, a profiler
   trace, a timing harness, or an instrumented run. Save the raw output.
3. Sample properly: at least 5 runs after a warmup; report median and spread. A
   single timing is a lead, not a measurement.
4. Form a hypothesis naming a file:line and a mechanism (extra allocation, N+1
   query, repeated parse, blocking work on the hot path). It must be falsifiable.
5. Isolate: use the profiler, an instrumented counter, or bisection to confirm the
   hotspot actually dominates the metric before changing anything.
6. Change one thing. One change per measurement — a two-change diff cannot attribute
   the delta to either change.
7. Re-measure with the identical workload and environment. Record the new numbers
   and the delta as a percentage together with the sample spread.
8. If the delta is inside noise, say so and revert or iterate; do not ship an
   unmeasured improvement. If it holds, verify correctness with the related tests.
9. Report the measurement table: baseline, change, after, delta, environment, and
   the exact commands to reproduce both runs.

## Output contract

- Metric and workload: what was measured and with what input.
- Hypothesis: file:line, mechanism, and how it was confirmed or rejected.
- Numbers: baseline and after, median plus spread, delta percentage, sample count.
- Change: the single change responsible, with file references.
- Correctness: test results proving behavior is unchanged.
- Reproduce: exact commands and environment details (CPU, versions, flags).

## Honesty rules

- Numbers come from executed runs; never estimate or recall prior timings as results.
- Report spread and sample count; a noisy delta is reported as NO-CHANGE, not a win.
- One change per measurement; attribute deltas only to the change actually isolated.
- Correctness evidence is required before claiming an acceptable optimization.
- Report PARTIAL when no profiler or benchmark runner is available, naming the gap.