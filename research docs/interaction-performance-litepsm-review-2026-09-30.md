# Interaction, performance and litePSM architecture review — 2026-09-30

Status: proposed design and source research. Runtime behavior was not implemented.
Fresh read-only audits covered every line of all36 prior Horizon ARCH documents:
15,949 lines. All26 litePSM ARCH documents were read:3,821lines. Input hashes/ranges
and final architecture hashes are in [coverage](source-audit-coverage/interaction-review-2026-09-30.json).
ARCH37/38 were read during authoring and final review. No sibling files were edited.
litePSM HEAD changed externally49ac134→a3ca33ba0dc51b7e2a2411349bedd2d021be9a1f;
the ARCH diff is empty, preserving the reviewed architecture snapshot.

## Findings and dispositions

- Artifact catalog/version feedback and bounded viewers: ARCH37/28; immutable refs,
  exact version anchors, metadata fallback, no preview completion authority.
- Composer chips: exact bytes, Unicode maps, duplicate labels, model caps, async races,
  draft leases/crash recovery and submission CAS; ARCH37/07/28.
- User queue/recap/branches: controller claims, original cursor, separate workspace
  choice, no copied approval or pending effects; ARCH37/27/25.
- Settings/theme/motion/streaming: semantic tokens, actual terminal fallback, reduced
  motion, no idle/replay animation, dirty visible regions and focus/selection retention.
- Fast path: mandatory policy gates with optional bounded background discovery,
  persistent services, rolling independent pool, conservative barriers, ordered model
  observations but immediate effect settlement, exact cache epochs and measured targets.
- Corrected active config fallback/hooks/collisions, skill-versus-WASM table, lossy
  selection/prototype compression, memory extraction enum, update pause eligibility,
  implementation-status promotion and disconnected MCP availability wording.
- Reconciled legacy runner graph mutation, context repo ownership, mandatory startup
  source handling, guard tickets/disconnect, fork open questions and quota authority.
  Owner reconciliation sections explicitly supersede remaining historical sketches.
- Required installer wrappers/onboarding: ARCH30; proposed only until independent
  signed-bootstrap trust/platform fixtures pass. No install scripts fabricated.
- litePSM ownership: ARCH38; portable bridge and two independent authorization domains,
  no shared DB/CAS/secret custody; sibling schemas/approval/journal/IPC remain gates.
- Ten delivery rows AX401..410 cover additions and depend on existing foundations.
  Planned acceptance expanded; no delivery status promoted.

## Pinned DeepSeek source observations

Pin:639ed015397290b3745d163aafe02ffee4aa3f84. These are source observations, not speed
benchmarks or guarantees inherited by Horizon. No code copied.

| Subsystem | Actual source inspected | Observation / Horizon disposition |
|---|---|---|
| Scheduler | [tool-calls.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/tool-calls.ts), all290lines | Rolling pool, exclusive barriers, ordered results, cancellation drain; retain Horizon frozen schema and live narrowing |
| Agent loop | [agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/src/agent.ts),258–380/479–550 | Inbox claim, prompt/prestep, step settlement, tools, error recovery |
| PTC bridge | [ptc.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/src/ptc.ts),1–210/390–770 | Nested governed calls, per-subcall events and bounded output; no bypass/replay |
| PTC process | [index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/ptc-runtime/ptc-runtime-node/src/index.ts),1–150 | Fresh confined Node per program; persistent harness != persistent Code Mode |
| Compaction | [summarizer.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/compaction/compaction-basic/src/summarizer.ts),all221lines | Warm prefix plus summary instruction; invalid/truncated output rejected, cache hit not guaranteed |
| Prompt order | [index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/system-prompt/src/index.ts),128–158 | Fixed reusable section ordering, dynamic local context late |
| Session events | [known-event-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/known-event-types.ts),all87lines | Explicit compatibility for unknown ignorable/required event types |
| Subagent depth | [depth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent/src/depth.ts),all50lines | Persisted monotone depth; Pinned path confirmed against tree |
| Ralph | [index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/workflow/tool-ralph/src/index.ts),all477lines | Structured bounded fresh rounds; reported complete is not independent certification |
| SDK | [client.ts](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/client/src/client.ts),177–220 | Lazy reused runtime; inspected path lacks wire cancel, timeout can leave work active |

Additional actual source ranges inspected by research worker: Cordis vendor service/
registry1–110, tool pipeline1290–1311/1488–1540, MCP activation147–205, sandbox
policy1–110 and workflow service1–120. Paths: `vendor/cordis/src/service.ts`, `vendor/cordis/src/registry.ts`,
`packages/core/tools/src/index.ts`, `packages/mcp/mcp-client/src/index.ts`,
`packages/sandbox/sandbox-policy/src/index.ts`, `packages/workflow/workflow/src/index.ts`.
All were confirmed against the pinned tree during final documentation validation. No assertion of complete repository-source reading.

## Official UI / installation references

[OpenCode TUI](https://opencode.ai/docs/tui/), [themes](https://opencode.ai/docs/themes/),
[keybinds](https://opencode.ai/docs/keybinds/), [configuration](https://opencode.ai/docs/config/)
and [installation/onboarding](https://opencode.ai/docs/) checked2026-09-30.
Its /settings occurrence is not evidence of a built-in command; Horizon owns that UI.
Adopt connect/route/project-init concepts with optional setup and reviewed file diffs.
[Claude commands](https://code.claude.com/docs/en/commands) and
[artifacts](https://code.claude.com/docs/en/artifacts) confirm public artifact commands;
exact bundled skill implementations are not public evidence here.
[Antigravity changelog](https://antigravity.google/docs/changelog) is a research source;
user-provided0–24ms/CPU/idle claims are anecdotes, not Horizon acceptance measurements.
[Grok README](https://github.com/xai-org/grok-build/blob/main/README.md) documents Bash/
PowerShell installer entry points; mutable documentation is not a pinned implementation
or platform acceptance. [Cline installation](https://docs.cline.bot/getting-started/installing-cline)
is a public install reference. Existing ARCH30 owns Codex packaging references; no new
complete Codex installer-source audit is claimed.

## Remaining evidence

Runtime/TUI/renderer/performance/platform installation and litePSM integration acceptance
remain open. Documentation checks verify links/IDs/fences/trace coverage, not behavior.
Sibling integration problems are not repaired by Horizon architecture prose. No model,
network mutation, deployment, publication, commit or push was performed.
