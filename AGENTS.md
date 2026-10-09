# HorizonCode v1 development guidance

## Architecture and repository state

- `arch_V1/` is the only normative HorizonCode v1 architecture. Read its relevant
  contracts before changing behavior or ownership. OpenCode source and its upstream
  documentation establish implementation facts only; they do not override `arch_V1/`.
- Root commit `0009178` established the docs-only bootstrap baseline. The current branch
  contains HorizonCode P1/P2/P4 prototype implementations, but not the OpenCode application
  base. The local working copy also has the pinned OpenCode snapshot
  `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`; those source files remain ignored and
  untracked, and are not in `main` or a fresh clone. Only `origin` is configured; no
  OpenCode `upstream` remote is configured.
- These are bootstrap facts, not completion claims. P0 archive/source provenance,
  OpenCode-base, inventory, baseline verification, generated-output, and license gates
  remain incomplete as recorded in [`arch_V1/10-DELIVERY.md`](arch_V1/10-DELIVERY.md).
  Do not claim implementation, runtime, platform, security, or release acceptance
  without the evidence required there and in `arch_V1/18-OPERATIONS-RELEASE.md`.
- Prior Git metadata and archive refs were purged. Do not claim old HorizonCode
  `ARCH/` documents or `crates/` are recoverable or use them as active guidance. Before
  considering a historical component, independently recover and verify its source, then
  record its migration-matrix row in `10-DELIVERY.md`, including its final v1 owner and
  interface, disposition, impact, and tests.
- Keep unavailable capabilities visibly unavailable. Unresolved decisions in
  `arch_V1/17-GOVERNANCE-DECISIONS.md` gate only their named capabilities; do not silently
  resolve them or broaden their safe interim behavior.

## Delivery phases and active work

`arch_V1/10-DELIVERY.md` is the source of truth for phase scope, dependencies, and
acceptance. Its complete phase sequence is:

| Phase | Name | Current status |
|---|---|---|
| P0 | Preserve Horizon and establish the OpenCode base | Incomplete; provenance, base, inventory, baseline, generated-output, and license gates remain open |
| P1 | Composition and typed service seam | Active; implementation and lifecycle acceptance remain incomplete |
| P2 | Rust kernel transport and canonical Thread | Active; canonical persistence, Thread ownership, and integration remain incomplete |
| P3 | Direct coding fast path and effects | Not active in this continuation |
| P4 | Repository intelligence and memory | Active; authorized acquisition and canonical owners remain incomplete |
| P5 | Agent profiles and subagents | Not active in this continuation |
| P6 | Durable managed execution | Not active in this continuation |
| P7 | Independent verification and acceptance | Not active in this continuation |
| P8 | Ecosystem and compatibility | Later phase |
| P9 | Web/Desktop polish and updates | Later phase; remote continuation is separately gated |

The current cross-phase objective is P1/P2/P4, with the approved P2 kernel foundation
as the next implementation work. Status labels are not acceptance claims; use each
phase's gate and `arch_V1/10-DELIVERY.md` evidence.

## Continuity and goal-control failures

- A goal/status plugin reporting that another process owns the workflow only disables
  that plugin's goal-state commands. It does **not** block ordinary repository work.
  Continue user-authorized discovery, design, implementation, testing, and handoff in
  this session; do not stop or demand a fork solely for that control-plane error.
- Never emit a goal-complete marker or describe the requested work as complete when only
  a design, plan, prototype, or subset of phase gates is complete. Report the exact
  completed work, remaining work, and the next concrete action instead.
- When a contract or source is missing, follow the user's fallback order: inspect the
  relevant `arch_V1/` contracts, inspect the local pinned OpenCode packages and actual
  repository patterns, then research primary external sources when needed. Design the
  smallest architecture-aligned safe seam, document any explicit migration/decision,
  implement it, and run its targeted tests. A missing dependency may gate only the
  capability that truly depends on it; continue independent authorized work and preserve
  fail-closed behavior rather than stopping the whole objective.
- Update `CURRENT_RUN.md` with exact files, fresh verification evidence, remaining gates,
  and numbered next steps whenever work pauses or ends. Do not re-ask for approval already
  given for the active design or implementation method.

## OpenCode source conventions

Apply these when working on the pinned OpenCode source, once it is intentionally part of
the work being changed. Confirm the actual checkout and package scripts first; a fresh
clone of the current `main` does not include that source.

- Keep the OpenCode tree substantially intact. Preserve runtime dependency direction:
  Schema → Core/Protocol → Server; Client may depend on Schema and Protocol, never Core
  or Server; `sdk-next` composes Client, Core, and Server.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from
  `packages/client`; do not hand-edit `src/generated` or `src/generated-effect`. To
  regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- Run tests and `bun typecheck` from the relevant package directory, not the repository
  root. Use the package's scripts and declared timeouts.
- Follow nearby conventions: prefer Bun APIs, inferred types, `const`, early returns,
  and functional array methods; avoid `any`, import aliases/star imports, needless
  destructuring, and premature single-use helpers. Keep Effect service bindings named
  before calling their methods; use snake_case for Drizzle field names.

## Branches and changes

- HorizonCode's active branch is `main`. Use short branch names of at most three
  hyphen-separated words, without type prefixes or slashes.
- Use conventional commit and PR titles: `type(scope): summary`; valid types are `feat`,
  `fix`, `docs`, `chore`, `refactor`, and `test`.
- Do not add old Horizon `ARCH/`, crates, a second agent loop, or competing owners to
  active `main`. Keep ownership aligned with `arch_V1/` and update its governing records
  when an approved architecture decision changes.
