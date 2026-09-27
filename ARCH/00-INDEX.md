# 00 — Index and Conventions

## Authority chain

1. **`ARCH/01-VISION.md`** — what HorizonCode intends to be and which outcomes matter. Root intent; competitive superiority is an evaluation question.
2. **`ARCH/02-REQUIREMENTS.md`** — the testable `REQ-*` surface.
3. **`ARCH/03-ARCHITECTURE.md`** — the architectural "how".
4. **`ARCH/04-DECISIONS.md`** — `DEC-*` records that constrain the architecture.
5. **`ARCH/05-SOURCE-LEDGER.md`** — `SRC-*` provenance and licensing dispositions.
6. Module-level documents (`ARCH/06`–`ARCH/28`, with `17` intentionally unused) — the "LLD" layer:
   - `06-UI.md` · `07-SESSION.md` · `08-LOOP.md` · `09-CONTEXT.md` · `10-TOOLS.md` · `11-PROVIDER.md` · `12-GUARD.md` · `13-SANDBOX.md` · `14-AUDIT.md` · `15-PROTOCOLS.md` · `16-ORCH.md` · `18-CONFIG.md` · `19-COMPRESSION.md` · `20-ANALYTICS.md` · `21-DISCOVERY.md` · `22-SECURITY.md` · `23-VERIFICATION.md` · `24-ARCHITECTURE-REVIEW.md` (dated evidence and defects) · `25-LONG-HORIZON-CONTROL.md` (integrated run/task LLD) · `26-CORE-AGENT-CROSSWALK.md` (agent-pattern reuse and limits) · `27-COMMANDS-AGENTS-SETTINGS.md` (command/mention registry, agent directory, quota visibility, and operator settings) · `28-ARTIFACT-STORE.md` (shared session/run payload lifecycle and integrity).

`TODO.md` is a delivery tracker, not a design authority. When it disagrees with `ARCH/`, `ARCH/` wins.

## Implementation-status rule

Architecture documents describe the intended contract unless a dated, source-backed
status block says otherwise. A source file or interface is **present**, not thereby
working. Use these distinct labels everywhere: `proposed` (design exists, no relevant
implementation), `implemented` (some or all source exists, with gaps stated), `verified`
(executable evidence names the exact revision/environment), `accepted` (the applicable
acceptance record exists), and `blocked` (a named dependency or external condition
prevents progress). A worker's report, a passing mock, an ACP event, or a TODO checkbox
cannot promote status. `TODO.md` is the live delivery ledger;
[`research docs/tests.md`](../research%20docs/tests.md) is the test and benchmark plan;
[`AGENTS.md`](../AGENTS.md) is the repository-wide operating contract.

The implementation snapshot for this document set is recorded in `CURRENT_RUN.md`.
When source changes, update both that snapshot and the affected delivery rows; do not
rewrite design as though it had shipped.

## Identifier conventions

| Prefix | Meaning | Example |
|---|---|---|
| `REQ-<AREA>-<nnn>` | Testable requirement | `REQ-LOOP-004` |
| `DEC-<nnn>` | Architecture decision | `DEC-003` |
| `SRC-<nnn>` | Source/provenance entry | `SRC-007` |
| `CMP-<name>` | Component | `CMP-runner` |
| `AX-<nnn>` | Delivery task in `TODO.md` | `AX-012` |
| `AX-<MISSION>-<nnn>` | Coding task bound to an architecture decision | `AX-ARCH-003` |

Area codes: `VISION`, `REQ`, `ARCH`, `LOOP`, `TOOL`, `CTX`, `PROV`, `GUARD`, `AUDIT`, `SBX`, `PROTO`, `SESS`, `ORCH`, `UI`, `HORIZON`, `REPO`, `RESEARCH`, `DELIVERY`, `MEM`, `SKILL`, `PLUGIN`, `ANALYTICS`, `SEC`, `PERF`, `VER`.

## Requirement quality bar

A requirement is accepted only if it is:
- **Observable** — a human or test can tell whether it holds.
- **Falsifiable** — there exists a check that could fail.
- **Bounded** — no unbounded scope ("works well" is not a requirement).
- **Scoped to where it is demonstrably true** — a guarantee that holds only on some
  tier, case, or configuration is written with that scope stated in the requirement
  itself, and labelled there, rather than stated universally. Where the strict form
  and the scoped form conflict, the strict form stays the floor and the weaker
  statement is narrowed to its real scope. The worked example is network confinement:
  "no outbound network" is the *request* a profile makes, and what a tier *enforces* is
  its declared `network_guarantee_level` (`DEC-026`, `DEC-027`). A caller that requires
  a level the tier cannot provide is **refused**, never silently degraded.
- **Never lowered to remove a contradiction** — a contradiction is resolved by a
  `DEC-*` and a scoped rewording, never by deleting the control.

## Vendor-neutral rule

Product copy remains neutral. Factual provider/model names are permitted where a user must identify a route, configure a local runtime, inspect a bill, or understand source provenance; research notes may name their subjects. No peer's name is used as an unsupported quality claim. License-required attribution is unconditional. `DEC-030` records this scoped correction to the older absolute ban.

## Change control

Any change to a boundary, protocol, or ownership rule requires:
- a new or amended `DEC-*` entry, and
- a corresponding `REQ-*` update if behavior changes.

A change to a **requirement's scope** also requires a `DEC-*` entry that records the
read-through, even when no behavior changes — that is how a universal wording becomes a
tier-scoped one without appearing to be a quiet weakening (`DEC-027` is the worked
example).

## How to read this set

Start with `01-VISION` for intent, `02-REQUIREMENTS` for the contract, then `03-ARCHITECTURE` for structure. Read `04-DECISIONS` before proposing structural changes. Read `05-SOURCE-LEDGER` before adding any dependency.
