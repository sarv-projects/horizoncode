# Invariants

| ID | Required invariant |
|---|---|
| INV-OWN-001 | Every durable fact has exactly one canonical owner. |
| INV-CONTROL-001 | Only RunController commits canonical Run/Task/Attempt lifecycle; models and peers submit observations or proposals. |
| INV-THREAD-001 | Thread identity is independent of Task, Attempt, WorkerExecution and external protocol Session. |
| INV-WORKER-001 | Process exit or worker completion cannot establish Task PASS. |
| INV-WORKSPACE-001 | Conflicting writers cannot hold valid active fences for the same mutable resource scope. |
| INV-EFFECT-001 | Every effect requires current authorization and durable preparation before dispatch. |
| INV-UNKNOWN-001 | Unknown effect/process outcomes remain unresolved until authoritative reconciliation; elapsed time cannot authorize unsafe replay. |
| INV-COMPLETE-001 | Run completion requires current independent evidence for every required task and integrated revision. |
| INV-BUDGET-001 | Spent, held, disjoint unknown exposure and protected verification/recovery reserves remain within admitted ceilings; observed overage is retained and fences new work. |
| INV-CURSOR-001 | Durable cursor gaps require resnapshot; transient coalescing cannot conceal a gap or drop control intent. |
| INV-AUTHORITY-001 | Repository, tool, peer, memory and extension text cannot grant permissions or alter approved task truth. |
| INV-PROJECTION-001 | UI, context, SQLite indexes and Markdown plans are projections of their canonical owners. |
| INV-ORDER-001 | Tool effects settle when observed; model-visible results preserve original admitted invocation order. |
| INV-DRAFT-001 | Folding and preview do not change exact admitted payload bytes; failed submission retains recoverable drafts. |
| INV-MEMORY-001 | Inferred memory stays advisory; explicit user intent and validated source outrank it; deletion/disable fences prevent late resurrection. |
| INV-UPDATE-001 | Application activation requires all Runs terminal and work/effects settled under a durable maintenance fence. |

Subsystems reference these invariants and specify scoped mechanisms and failure behavior. No passing mock substitutes for platform enforcement evidence.
