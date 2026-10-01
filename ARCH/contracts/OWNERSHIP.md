# Ownership

## Canonical fact owners

| Fact or operation | Canonical owner | Consumers / operational boundary |
|---|---|---|
| Thread, turns, input receipts, drafts, branches, context epochs | CMP-session | Runner submits append requests; UI and indexes consume committed projections |
| Run, Goal, Task, Attempt, WorkerExecution identity and committed lifecycle | CMP-orch | Host supplies observations; worker reports are proposals |
| Global work/run/maintenance admission and fencing | CMP-orch SupervisorControlStream | Does not own individual task completion |
| Workspace identity, revisions, writer fences and integration observations | CMP-workspace | Provider adapters implement Git or other revision models |
| Process launch, observation and cancellation mechanisms | CMP-execution-host | Durable lifecycle transitions are committed by CMP-orch or direct-turn owner |
| Tool definitions and materialization | CMP-tools | Scheduler classifies invocations; no separate policy engine |
| Policy decision, approval challenge and authorized resource ceiling | CMP-guard | Sandbox enforces reach; authorization is not confinement proof |
| OS confinement mechanisms and actual guarantee observations | CMP-sandbox | Host launches with the selected supported mechanism |
| Security audit chain and anchoring | CMP-audit | Linked effect IDs; not a duplicate business event store |
| Immutable artifact bytes and lifetime leases | CMP-artifact | Logical artifact versions/feedback stay with Thread/Run owner |
| Verification observations and bounded verifier execution | CMP-verifier | CMP-orch validates evidence binding and commits Task verdict |
| Memory content, revisions, capture and deletion generations | CMP-memory | Configuration owns settings; context consumes eligible selections |
| Repository indexes, LSP/SCIP generations and sourced intelligence | CMP-repo-intel | Context ranks results; no duplicate semantic index |
| Provider catalog, route capabilities and transport observations | CMP-provider | Analytics records usage; controller owns retry/spend policy |
| Usage/cost observation ledger | CMP-analytics | Estimates never increase hard ceilings |
| Effective configuration and provenance | CMP-config | Does not store memory or run tools |
| Agent profile definitions and trust lifecycle | CMP-agent-directory | CMP-worker renders execution configuration |
| Manager selection and normalized catalog/operation projection | CMP-extension-manager | litePSM or explicit local adapter owns its catalog/package lifecycle; CMP-config owns local definitions/enablement; CMP-mcp owns MCP execution |
| Control transport and authenticated ingress | CMP-control-api | Domain owner performs mutation; transport cannot grant authority |
| UI projection, focus, selection and viewport | CMP-tui | No surface writes owner databases |

Each record has one owner even when its bytes, projection and verifier have different operational roles. Cross-owner effects use stable operation IDs, durable receipts and reconciliation; there is no implied atomic transaction across stores.
