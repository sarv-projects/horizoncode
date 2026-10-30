---
name: browser-smoke-test
description: Use when a UI change needs a real browser journey: run the available browser or CLI tooling, capture steps and console or screenshot evidence, and report pass or fail per step.
---

# Browser Smoke Test (builtin.browser-smoke-test)

Run one real browser journey against the running app and collect evidence per step.
Use whatever browser or CLI tooling the environment actually provides, capture
screenshots or console and network output, and report pass or fail for each step.
This skill does not write source; fixes are delegated back to the user or a task.

## When to use

- A UI or route change needs verification in a real browser, not just unit tests.
- A release gate requires a manual-style smoke journey with recorded evidence.
- A bug report describes a user-visible flow that must be reproduced.
- An end-to-end pass is needed quickly before deeper testing.

## Workflow

1. Identify the app start path from the repo map: dev command, port, and any
   required services or environment variables. Record where each came from.
2. Start the app with bash as a background job; wait for the port to accept
   connections and capture the startup log tail as evidence.
3. Load the browser tooling the environment provides — an installed CLI runner, an
   automation library, or the product browser integration. State which was used.
4. Walk the journey step by step: navigate, act, assert. For each step record the
   action, the observable result, and the evidence captured (screenshot, DOM text,
   status code, console message).
5. Capture global signals during the run: console errors, failed network requests,
   and unhandled rejections. Attach the raw output, not a paraphrased summary.
6. Assert the final state explicitly: expected URL, expected visible content, and
   absence of error banners. A journey without a final assertion is incomplete.
7. Stop the background server and any browser processes; confirm they exited and
   release any ports they held.
8. Build the per-step pass or fail table and re-run any failed step once to
   distinguish a real failure from a startup race.

## Output contract

- Environment: app command, URL, browser tooling used, and run timestamp.
- Journey steps: numbered, each with action, expected, actual, and pass or fail.
- Evidence: screenshots or console and network output, attached or quoted.
- Issues: console errors and failed requests with severity and reproduction detail.
- Source-write status: explicit statement that no source was written, or which
  delegated change was made.
- Verdict: overall SMOKE-PASS or SMOKE-FAIL with the first failing step named.

## Honesty rules

- Evidence is what the browser actually returned; never infer a step passed from code.
- A step that could not run (missing tooling, blocked port) is UNKNOWN, not passed.
- Do not write source in this skill; report the defect and delegate the fix.
- Do not claim the journey passed if any step failed or was skipped.
- Report PARTIAL when the app or tooling is unavailable, with the exact blocker.