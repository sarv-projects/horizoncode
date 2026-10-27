# RC0 evidence artifacts (raw, actually captured)

These files are raw, actually captured harness artifacts and verification logs. The captures are
**not** product-session resource baselines and must not be cited as performance results or JCode
comparisons.

| Artifact | Method | Status |
|---|---|---|
| `2026-10-16-rc0-selfcheck-linux-wsl.jsonl` | `python3 scripts/perf/rc0.py` sampling an owned `bash` + `sleep` tree through one owner-issued `PID:start_identity`, emitting the four requested session-count records (1/5/10/20) | NOT_BASELINE — dirty tree, 1 of 5/10/20 sessions supplied, no task outcomes |
| `2026-10-16-rc0-harness-selfcheck.jsonl` | `python3 scripts/perf/rc0.py --selfcheck` sampling its own real bounded tree and requiring every required metric to be MEASURED | harness smoke check, PASS |
| `2026-10-16-p8-cargo-lib-resource.log` | `cargo test --manifest-path kernel/Cargo.toml --locked --offline --lib resource` | 20 passed / 0 failed (15 `resource_budget` + 4 `resource_sampler` in-file + 1 unrelated guard test matching the filter) |
| `2026-10-16-p8-cargo-resource-sampler.log` | `cargo test --manifest-path kernel/Cargo.toml --locked --offline --test resource_sampler` | 12 passed / 0 failed |
| `2026-10-16-p8-pytest-rc0.log` | `python3 -B -m pytest -p no:cacheprovider test_rc0.py -v` in `scripts/perf/` | 23 passed / 0 failed |

All logs above were produced on 2026-10-16 against working-tree revision `9b667a32fa5d…` (dirty
by design; user-owned changes preserved).

Environment recorded in the captures: Linux WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`,
x86_64, 4 logical CPUs, ~8.3 GB RAM, commit `9b667a32fa5d…` with a dirty working tree.
WSL is not native-Windows evidence.

## What a valid RC0 baseline still needs (§18.17 / docs/performance/README.md)

- a clean, exact-commit checkout and a built product (CLI/TUI) under test;
- real 1/5/10/20 direct Sessions with owner-issued PID/start identities;
- recorded task outcomes (expected/actual/status) per session so correctness is bound to the
  measurement;
- warm/cold runs repeated at least three times, local inference included/excluded recorded
  separately, provider/model and harness pinned;
- native Windows and macOS captures where claimed (`JC-RES-004`); unsupported counters stay
  UNKNOWN, never zero.

`python3 scripts/perf/rc0.py --selfcheck` is the reproducible OS smoke check: it samples its own
real bounded process tree and exits nonzero unless the sample is complete and MEASURED. Run it
before trusting a capture environment.
