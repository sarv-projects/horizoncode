# Grok Build workflow patterns

**Scope and evidence.** Source was inspected at `xai-org/grok-build` commit
[`f0e3be1100ef5252488e3be8bb0e91cf68d8c305`](https://github.com/xai-org/grok-build/tree/f0e3be1100ef5252488e3be8bb0e91cf68d8c305)
(2026-09-23), Apache-2.0. Relevant files include:

- [`xai-workflow/engine.rs`](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-workflow/src/engine.rs)
- [`xai-workflow/journal.rs`](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-workflow/src/journal.rs)
- [`xai-workflow/validate.rs`](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-workflow/src/validate.rs)
- [`xai-workflow/host.rs`](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3bb0e91cf68d8c305/crates/codegen/xai-workflow/src/host.rs)
- [`workflow runs` and resume behavior](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3bb0e91cf68d8c305/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md)
- [workflow/plan mode guide](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3bb0e91cf68d8c305/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md)

This is a bounded review of workflow-related implementation and user docs, not a
claim that every Grok Build file or feature has been audited. No implementation code,
schema, tests, or assets were copied.

## Observed patterns

- Workflows have a discoverable name/description and a validated phase/operation
  structure. The user-facing guide shows project and user workflow locations and a
  `/workflows` catalog.
- A host mediates tool operations and tracks run IDs, arguments, completed calls,
  limits, cancellation, and displayed run status. This is more observable than an
  opaque prompt macro.
- Journaling stores a request identity and committed host-call results so replay can
  detect changed inputs/divergence. Validators bound operations and structured values.
- Plan mode and workflow authoring are separate user activities. A proposed plan is
  inspectable before execution; workflow runs have their own status surface.

## Limits relevant to HorizonCode

At this pinned revision, user documentation states that a workflow paused and resumed
in the same process continues the original immutable script/arguments/budget; runs
interrupted by process restart do not resume. It also documents that a same-process
resume can repeat an external effect whose result was not durably committed. Therefore
the feature is evidence for authoring/validation/visibility patterns, not proof of
restart-safe long-horizon execution or exactly-once effects.

## HorizonCode disposition

`DEC-068` and `ARCH/product/COMMANDS-AND-SETTINGS.md` specify a guided Workflow Builder that saves versioned,
validated task-graph templates. Invoking a template creates an ordinary HorizonCode
Run and goes through the existing approval, budget, guard, sandbox, audit, recovery,
and independent-verification contracts. A workflow file is inert data; there is no
Rhai-compatible engine or second scheduler. This keeps workflow authoring useful while
preserving one source of task truth. Tests belong to `AX-377` and
[`research docs/tests.md`](tests.md).
