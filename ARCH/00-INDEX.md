# 00 — Index and Conventions

## Authority chain

1. **`ARCH/01-VISION.md`** — what agentX is and why it wins. Root intent.
2. **`ARCH/02-REQUIREMENTS.md`** — the testable `REQ-*` surface.
3. **`ARCH/03-ARCHITECTURE.md`** — the architectural "how".
4. **`ARCH/04-DECISIONS.md`** — `DEC-*` records that constrain the architecture.
5. **`ARCH/05-SOURCE-LEDGER.md`** — `SRC-*` provenance and licensing dispositions.
6. Module-level documents (`ARCH/06`–`ARCH/23`) — the "LLD" layer:
   - `06-UI.md` · `07-SESSION.md` · `08-LOOP.md` · `09-CONTEXT.md` · `10-TOOLS.md` · `11-PROVIDER.md` · `12-GUARD.md` · `13-SANDBOX.md` · `14-AUDIT.md` · `15-PROTOCOLS.md` · `16-ORCH.md` · `18-CONFIG.md` · `19-COMPRESSION.md` · `20-ANALYTICS.md` · `21-DISCOVERY.md` · `22-SECURITY.md` (consolidated threat model) · `23-VERIFICATION.md` (verification strategy). (`17` is intentionally unused.)

`TODO.md` is a delivery tracker, not a design authority. When it disagrees with `ARCH/`, `ARCH/` wins.

## Identifier conventions

| Prefix | Meaning | Example |
|---|---|---|
| `REQ-<AREA>-<nnn>` | Testable requirement | `REQ-LOOP-004` |
| `DEC-<nnn>` | Architecture decision | `DEC-003` |
| `SRC-<nnn>` | Source/provenance entry | `SRC-007` |
| `CMP-<name>` | Component | `CMP-runner` |
| `AX-<nnn>` | Delivery task in `TODO.md` | `AX-012` |
| `AX-<MISSION>-<nnn>` | Coding task bound to an architecture decision | `AX-ARCH-003` |

Area codes: `VISION`, `REQ`, `ARCH`, `LOOP`, `TOOL`, `CTX`, `PROV`, `GUARD`, `AUDIT`, `SBX`, `PROTO`, `SESS`, `ORCH`, `UI`, `HORIZON`, `MEM`, `SKILL`, `PLUGIN`, `ANALYTICS`, `SEC`, `PERF`, `VER`.

## Requirement quality bar

A requirement is accepted only if it is:
- **Observable** — a human or test can tell whether it holds.
- **Falsifiable** — there exists a check that could fail.
- **Bounded** — no unbounded scope ("works well" is not a requirement).

## Vendor-neutral rule

This repository must contain **no vendor, competitor, or assistant brand names** in source, commit messages, help text, or documentation. Upstream dependencies are referenced by role and license in `ARCH/05-SOURCE-LEDGER.md`. Attribution that a license legally requires is carried in a generated `THIRD-PARTY-NOTICES.md` at release time, not prose.

## Change control

Any change to a boundary, protocol, or ownership rule requires:
- a new or amended `DEC-*` entry, and
- a corresponding `REQ-*` update if behavior changes.

## How to read this set

Start with `01-VISION` for intent, `02-REQUIREMENTS` for the contract, then `03-ARCHITECTURE` for structure. Read `04-DECISIONS` before proposing structural changes. Read `05-SOURCE-LEDGER` before adding any dependency.
