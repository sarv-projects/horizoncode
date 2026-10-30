---
name: plan-change
description: Use when a change request must become a scoped implementation plan with acceptance criteria, touched files, risk, and test strategy before any edit.
---

# Plan a Change (builtin.plan-change)

Turn a change request into a scoped, evidence-backed implementation plan without
editing source. The plan is the deliverable: scope, touched files, acceptance
criteria, risk, and test strategy, all grounded in files actually read. In a
direct session the user approves inline; in a managed run the plan becomes the
task DAG that parallel workers execute.

## When to use

- The user asks for a plan, a design, or an approach before implementation.
- A change spans multiple files or packages and the scope is not yet bounded.
- Parallel implementation will be dispatched and workers need bounded scopes.
- The request is ambiguous enough that guessing the touched files is unsafe.

## Workflow

1. Restate the request in one paragraph: goal, constraints, and what must not
   change. List open questions; ask the user only where the answer changes the plan.
2. Read the governing rules file (AGENTS.md) and any task-adjacent docs; skim only
   the sections that bind this change. Do not load the whole doc corpus.
3. Locate the affected code with grep and glob: entrypoints, exported symbols,
   config keys, and tests that already cover the area. Read each candidate file.
4. Enumerate touched files explicitly: files to edit, files to add (tests, config),
   and files deliberately untouched. For each, state why it is in scope.
5. Trace blast radius: grep for callers and consumers of every symbol you will
   change, including other packages and public exports. Note downstream risk.
6. Write acceptance criteria as testable statements: observable behavior, edge
   cases, and error paths. Each criterion maps to a command that proves it.
7. Define the test strategy: which existing tests currently fail or pass, which
   tests to add, and the exact commands (focused first, then package, then repo-wide).
8. Assess risk: blast radius, data or state migration, rollback path, and any
   mutation that must cross the Guard. Rank steps from low to high risk.
9. Break the work into ordered steps small enough to verify individually; state
   dependencies between steps so parallel dispatch is safe.
10. Present the plan and stop. Do not edit source until the user approves it or a
    managed run explicitly dispatches implementation.

## Output contract

- Goal and non-goals: one paragraph each, including what is explicitly excluded.
- Touched files: path, action (edit, add, read-only), and reason.
- Acceptance criteria: numbered, testable, each with its proving command.
- Implementation steps: ordered, individually verifiable, with dependencies.
- Risk: blast radius, rollback, Guard-relevant mutations, open questions.
- Test strategy: existing coverage, new tests, exact commands per level.

## Honesty rules

- Base every claim on a file read this session; never plan from memory of similar repos.
- Mark uncertain APIs, owners, and behaviors UNKNOWN and surface them as questions.
- Do not claim a plan is verified — a plan is proposed until implementation proves it.
- Do not edit source in this skill; the deliverable is the plan only.
- If scope cannot be bounded, say so and propose the smallest safe first slice.