# HorizonCode Harness Performance Dashboard

Generated: 2026-10-28T17:02:45.552Z

## Sources

- Session events: 39 events / 2 sessions (from `scripts/eval/metrics-fixtures/sample_events.jsonl`)
- Run records: 7 records from 8 files (`scripts/eval/metrics-fixtures/sample_runs`)
- Pinned model: `openrouter/nemotron-3-super-120b-a12b`
- Note: malformed event lines: 1
- Note: malformed run records: 1
- Note: events without sessionID (skipped): 1
- Note: unrecognized event types (ignored): 1

## [MODEL GUARD WARNING] MODEL IDENTITY GUARD: **FAILED (3 mismatch(es), 1 switch(es))**

Every request must use the pinned model `openrouter/nemotron-3-super-120b-a12b`.

**1 model switch event(s) observed — validity failure counted in safety metrics.**

| Source | Observed model | Session / task |
|---|---|---|
| session.next.model.switched | `openrouter/gpt-5.6-luna` | ses_b4d5e6 |
| session.next.step.started | `openrouter/gpt-5.6-luna` | ses_b4d5e6 |
| run-record | `openrouter/gpt-5.6-luna` | task-005 |

### Harness & System Performance

| Metric | Value (median / p95) | n | Status | Basis |
|---|---|---:|---|---|
| Verified task success | 28.57 % | 7 | measured | run records: verified_success |
| Regression-free success | 100 % | 2 | measured | run records: regression_free among verified successes |
| Task completion time | median 71,000 ms (71.00 s) | p95 300,000 ms (300.00 s) | 7 | measured | run records: duration_ms (all runs) |
| Time-to-first-action | median 900 ms | p95 1,000 ms (1.00 s) | 2 | measured | session events: prompt -> first tool call |
| Model latency (per step) | median 1,400 ms (1.40 s) | p95 1,600 ms (1.60 s) | 5 | measured | session events: step.started -> step.ended |
| Tokens per task | median 6,950 tokens | p95 9,320 tokens | 5 | measured | run records/session linkage: input+output+cached per task (partial coverage: 5/7 reported) |
| Cost per successful task | median $0.0142 | p95 $0.0254 | 2 | measured | run records/session linkage: reported cost of verified runs |
| Tool-call success rate | 50 % | 6 | measured | session events: tool.success vs tool.failed |
| Recovery rate | 33.33 % | 3 | measured | run records: runs with tool_errors>0 that still verified |
| Crash / timeout rate | 14.29 % | 7 | measured | run records: failure_category=infrastructure (derived classifier) |
| Reproducibility (identical repeats) | 0 % | 1 | measured | run records: repeated tasks with identical outcomes across runs |
| Safety violations blocked | 3 count | 2 | estimated | session events: denial/destructive pattern matches (heuristic) |

### Speed Timeline

| Metric | Value (median / p95) | n | Status | Basis |
|---|---|---:|---|---|
| TTFT (first token) | median 300 ms | p95 400 ms | 4 | measured | session events: step.started -> first text.started/delta |
| Time-to-first-useful-action | median 1,000 ms (1.00 s) | p95 2,900 ms (2.90 s) | 2 | measured | session events: prompt -> first tool.success |
| Model time (total) | 6,350 ms (6.35 s) | 5 | measured | sum of closed step durations |
| Tool time (total) | 1,900 ms (1.90 s) | 6 | measured | sum of closed tool-call durations |
| Time-to-first-patch | median 2,000 ms (2.00 s) | p95 2,000 ms (2.00 s) | 1 | measured | session events: prompt -> first file-mutating tool call |
| Time-to-first-passing-test | median 1,800 ms (1.80 s) | p95 1,800 ms (1.80 s) | 1 | measured | session events: prompt -> first test-classified command with exit 0/tool success |
| Total-to-verified-success | median 42,000 ms (42.00 s) | p95 64,000 ms (64.00 s) | 2 | measured | run records: duration_ms of verified runs |
| Idle time | median 260 ms | p95 1,100 ms (1.10 s) | 2 | measured | session events: span minus union of model/tool intervals |
| Step latency | median 1,400 ms (1.40 s) | p95 1,600 ms (1.60 s) | 5 | measured | session events: step.started -> step.ended |

### Tokens & Cost

| Metric | Value (median / p95) | n | Status | Basis |
|---|---|---:|---|---|
| Input tokens (total) | UNKNOWN | 0 | **UNKNOWN** | sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total |
| Output tokens (total) | UNKNOWN | 0 | **UNKNOWN** | sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total |
| Reasoning tokens (total) | UNKNOWN | 0 | **UNKNOWN** | sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total |
| Cache-read tokens (total) | UNKNOWN | 0 | **UNKNOWN** | sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total |
| Cache-write tokens (total) | UNKNOWN | 0 | **UNKNOWN** | sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total |
| Tokens per successful task | median 6,950 tokens | p95 9,200 tokens | 2 | measured | run records/session linkage: tokens of verified runs |
| Retry count | 1 count | 2 | measured | session events: session.next.retried |
| Retry token overhead | UNKNOWN | 0 | **UNKNOWN** | per-retry token attribution is not emitted by the session event contract |
| Context tokens included (per request) | median 3,500 tokens | p95 5,200 tokens | 2 | measured | session.context_ledger: latest ledger included-entry tokens |
| Request payload bytes | median 39,000 bytes | p95 48,211 bytes | 2 | measured | session.context_ledger: requestBytes (payload bytes, not tokens) |
| Context utilization vs window | median 1.34 % | p95 1.98 % | 2 | measured | context ledger tokens / provided model window |
| Compactions per session | median 0 count | p95 1 count | 2 | measured | session events: session.next.compaction.started per session |
| Cost per task | median $0.0201 | p95 $0.0410 | 7 | measured | run records/session linkage: reported cost per run |
| Cost per verified solve | median $0.0142 | p95 $0.0254 | 2 | measured | run records/session linkage: reported cost of verified runs |

### Tool Loop

| Metric | Value (median / p95) | n | Status | Basis |
|---|---|---:|---|---|
| Tool-call success rate | 50 % | 6 | measured | session events: tool.success vs tool.failed |
| Invalid tool args | 2 count | 6 | measured | session events: tool.failed with invalid-argument message pattern |
| Command exit-code distribution | exit 0: 1 | 1 | measured | 1/2 shell calls reported an exit code |
| File-op failure rate | 66.67 % | 3 | measured | session events: file-mutating tool failures |
| Patch-apply failure rate | UNKNOWN | 0 | **UNKNOWN** | session events: patch/apply tool failures: no observations |
| Duplicate calls | 1 count | 2 | measured | session events: identical (tool,input) repeats within a session |
| No-progress loops | 1 count | 2 | measured | session events: identical (tool,input) failing >=2 times in a session |
| Recovery after error | 100 % | 1 | measured | session events: sessions with a tool success after a tool failure |
| Tests triggered per task | median 1 count | p95 1 count | 7 | measured | session events linked by run.session_id: test-classified commands per task |
| Tests triggered per session | median 0 count | p95 1 count | 2 | measured | session events: test-classified commands per session |
| Turns until first tool success | median 1 turns | p95 2 turns | 2 | measured | session events: model steps up to first tool.success |
| Turns until verified success | median 6 turns | p95 11 turns | 7 | measured | run records: turns field (7 samples) |
| Cancellation responsiveness | UNKNOWN | 0 | **UNKNOWN** | session event contract carries no cancellation-request/acknowledgement pair |

### Reliability & Safety

| Metric | Value (median / p95) | n | Status | Basis |
|---|---|---:|---|---|
| Finish normally | 100 % | 5 | measured | session events: Step.Ended finish in {stop, tool-calls, end_turn} |
| Patch inspectable | UNKNOWN | 0 | **UNKNOWN** | no patch-inspection evidence emitted in session events or run records |
| Verification completes | UNKNOWN | 0 | **UNKNOWN** | no verification-completion signal emitted in session events or run records |
| Resume after interrupt | UNKNOWN | 0 | **UNKNOWN** | no interrupt/resume signal emitted in session events or run records |
| pass@1 across repeats | median 50 % | p95 50 % | 1 | measured | run records: per-task pass rate across repeated runs (>=2 runs) |
| Blocked unauthorized writes | 1 count | 2 | estimated | session events: failed file-mutating calls with denial-shaped errors (pattern match) |
| Blocked destructive commands | 1 count | 2 | estimated | session events: failed shell calls matching destructive patterns (pattern match) |
| Approval-bypass attempts | UNKNOWN | 0 | **UNKNOWN** | no approval-bypass telemetry emitted in the session event contract |
| Secrets in logs detected | UNKNOWN | 0 | **UNKNOWN** | no secret-scan telemetry emitted in the session event contract |
| Blocked unsafe attempts (pattern) | 1 count | 2 | estimated | session events: tool failures with denial-shaped errors (pattern match) |
| Model identity violations (safety/validity) | 4 count | 12 | measured | model guard: mismatches + model-switch events (safety/validity failure) |

### Failure Classification

| Primary category | Count |
|---|---:|
| model | 1 |
| harness | 1 |
| environment | 0 |
| verification | 2 |
| infrastructure | 1 |
| budget | 0 |
| unknown | 0 |

| Contributing cause | Count |
|---|---:|
| invalid_tool_args | 2 |
| model_switch | 2 |
| no_tool_errors | 1 |
| provider_retries | 2 |
| tool_errors | 2 |

Classified failures: 5 / 7 records.

## UNKNOWN metrics (13)

- `inputTokens` — sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total
- `outputTokens` — sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total
- `reasoningTokens` — sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total
- `cacheReadTokens` — sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total
- `cacheWriteTokens` — sum of step usage (session events): partial coverage 4/5 — refusing to fabricate a total
- `retryTokenOverhead` — per-retry token attribution is not emitted by the session event contract
- `patchApplyFailureRate` — session events: patch/apply tool failures: no observations
- `cancellationResponsiveness` — session event contract carries no cancellation-request/acknowledgement pair
- `patchInspectableRate` — no patch-inspection evidence emitted in session events or run records
- `verificationCompletesRate` — no verification-completion signal emitted in session events or run records
- `resumeAfterInterruptRate` — no interrupt/resume signal emitted in session events or run records
- `approvalBypassAttempts` — no approval-bypass telemetry emitted in the session event contract
- `secretsInLogsDetected` — no secret-scan telemetry emitted in the session event contract

---
Statuses: measured = observed in emitted telemetry; estimated = pattern/provenance-derived; **UNKNOWN** = not derivable from current sources (never fabricated).

