# DEC-096 — Direct user saves and scoped advisory memory

Decision date: 2026-10-01. This records the target design selected during the authorized architecture refactor; it does not establish runtime delivery.

## Decision

An admitted explicit user request to remember a preference or note is sufficient authorization to save that exact content in the resolved scope. Do not ask the user to approve the same save again. Ambiguous content/scope requires clarification; model additions beyond the request do not inherit that authorization.

New installations default to local project advisory capture with passive visibility and correction controls. Advisory observations remain explicitly inferred, retain evidence and cannot become user-confirmed facts or permission. Automatic global inference is disabled. Existing installations preserve their effective capture mode during migration. Users can choose explicit-only or off, independently disable retrieval, inspect usage, edit, forget, dismiss inferred patterns, export and purge.

Changed source-backed observations are retained as revalidation leads. They cannot establish present source truth until current sources are checked. Explicit preferences do not expire merely because files changed. Direct task instructions and current code/configuration take precedence in their respective domains.

Children receive task-selected memory only within admitted context and egress scopes. Permitted child captures are advisory; children cannot manufacture user consent, widen scope or mutate parent memory. Generation fences prevent late background jobs from resurrecting forgotten or disabled memory.

## Rationale

Developer reports describe both painful repetition and harmful memory bloat or incorrect interpretation. The target therefore reduces redundant friction while preserving inspectable provenance and correction. Official Claude documentation demonstrates automatic memory and user controls; older Cursor documentation included review for background notes. No universal user preference is asserted.

Research URLs and sampling limitations are retained in [memory experience research](../../../research/MEMORY-UX-RESEARCH.md). The final target is [Memory](../../../../ARCH/product/MEMORY.md).

## Consequences

REQ-MEM-002 distinguishes automatic advisory storage from confirmed facts. REQ-MEM-004 defines direct saves, scope/mode defaults and correction. REQ-MEM-006 permits policy-authorized scoped child observations without user-confirmation claims. Memory settings, context packets, command descriptors and acceptance cases change together. Original DEC-067/072 remain historical records and are not edited to imply these were their original decisions.

SQLite transactions, outbox/audit reconciliation, bounded retrieval, stable project identities, privacy and verification separation remain required. New admission defaults do not establish sandboxing, grant tool access or allow memory to satisfy acceptance.
