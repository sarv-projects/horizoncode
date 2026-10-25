# HorizonCode first-party identity audit — 2026-10-25 (read-only)

**Status:** READ-ONLY AUDIT / CLASSIFICATION ONLY. No source, config, `.gitignore`, ledger or other
report was modified; no Git mutation, no Cargo, no package-wide typecheck, no provider/network call
was made. This file is the single write of this task.

**Governing rules used to classify:**

- **User ruling (controls):** *"the provider package stays explicitly OpenCode-derived and reused
  as-is, so future upstream upgrades stay easy. Everything else first-party should be `horizoncode`."*
- `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.7 — First-party identity amendment (2026-10-23) +
  Provider-source amendment (2026-10-23) + License amendment (2026-10-25).
- `arch_V1/20-OPENCODE-INTEGRATION-LLD.md` §20.16 (provider-layer standalone SDK boundary),
  §20.17 + §20.17.1 (staged migration procedure; "a zero-string grep is not the success criterion").
- `arch_V1/10-DELIVERY.md` §10.12 (V1 identity exit; build-graph optimization stays post-V1).
- `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` NAME-001..004.
- `reports/phases/P9.md` §9 Stage-1 inventory, §13/§14 Stage-2 client+sdk-next waves, §16 runtime
  Context-tag wave, §18 lockfile importer identity, §24 read-only map refresh.

---

## 1. Method and scope

Exhaustive `ripgrep` pass over the whole tree (tracked **and** untracked) with
`--no-ignore --hidden`, i.e. content that the root blanket-`*` `.gitignore` hides is included.

**Excluded from every count** (per task scope / scratch): `node_modules`, `.git`, `target*`, `dist`,
`.tmp*`, `tmp/`, `hz-t/`, `*.log`, `.agent-tmp/`, `.p1*`, `.p6-e2e/`, `.p7*`, `.horizoncode-run/`,
`.horizoncode-e2e*/`, `.slim/`, `.turbo/`, `.code-intelligence/`, `.freebuff/`, `.superpowers/`,
plus nested package scratch (`packages/opencode/{tmp,.p4test,.p7-sandbox,opencode-test-*,.horizoncode-e2e-*}`).

**Pattern groups scanned (11):** `opencode|OpenCode|OPENCODE`, `@opencode-ai/`, `horizoncode`,
`hzcode`, `oh-my-pi|OMP`, `codex|Codex`, `claude-code|anthropic`, `Cursor` (product, cased),
`cursor` (lowercase, non-identity), `Devin`, `Windsurf`.

**Two-level classification.** Bucket is assigned per *file path* (ownership), then genuine
upstream/vendor/compat *facts inside a MIGRATE file* are reassigned line-by-line by token
(`anomalyco`, `opencode.ai` URLs, npm `opencode-ai`, `@opencode-ai/client`, vendor auth packages,
`OPENCODE_*` env names, `packages/opencode`/`opencode/` source paths, `~/.opencode`, `.opencode/`,
`--sso-session=opencode`, `pinned/upstream OpenCode`, `OpenCode-derived`, `OpenCode Default/Go`, …).
Counts are therefore **exact per file and ±line-level for mixed files**; §7 lists every manual
adjustment a human should confirm.

**Hydration fact used throughout:** the root workspace is hydrated from the pinned `opencode/`
snapshot. Of the 3,278 first-party-path files that contain identity strings, **757 are tracked,
2,519 are hidden (ignored) and byte-identical to the pin, 2 are untracked-but-visible.**
`scripts/architecture/audit_overlay_visibility.py` currently reports
`compared=6627 changed=465 missing=0 hidden_changed=0 hidden_new_source=3` — i.e. every real
HorizonCode delta is visible **today**; the trap (§9) is what happens the moment an identity edit
touches one of the 2,519 hidden files.

---

## 2. Bucket totals (all 11 pattern groups combined)

| Bucket | Hits | Files | One-line reason |
|---|---:|---:|---|
| **1 — MIGRATE** | **42,178** | **3,090** | First-party HorizonCode identity: user-facing names, package scopes, generated clients, build/typecheck/workflow/CI, first-party prose |
| **2 — KEEP provider package (user ruling)** | **1,793** | **97** | The §20.16-mapped provider/auth layer, kept OpenCode-derived for upgrade ease |
| **3 — KEEP upstream/vendor** | **68,086** | **4,032** | Pinned `opencode/**`, reference clones' upstream code, vendored `@opencode-ai/client`, vendor auth packages, provenance pins/URLs/npm IDs inside first-party files |
| **4 — KEEP legal/attribution** | **19** (12 auto + 7 line-level) | **11** | `LICENSE`, `NOTICE`, package `LICENSE` files, copyright comments, ToS/legal prose. Never falsified |
| **5 — KEEP factual compat/config** | **5,503** | **709** | `OPENCODE_*` env contract, `~/.opencode`/`.opencode/` paths, `packages/opencode`/`opencode/` source paths, sso-session name, `.gitignore` overlay paths |
| **6 — KEEP research/evidence** | **488,293** | **16,853** | `repo_take/`, `repos/`, `docs/architecture-archive|input|research|audits`, `reports/`, status logs, `arch_V1` audit manifests and OMP chapters |
| **7 — OUT OF SCOPE / decision needed** | **3,948** (760 genuine + 3,188 non-identity `cursor`) | **564** | Provider-package scope question, upstream CI workflows/secrets, generic `cursor` tokens |
| **Total classified** | **609,813** | — | (files de-duplicated per bucket; a file may appear in two buckets only when line-level facts were split out of it) |

### 2.1 Per-pattern cross-tab (hits)

| Pattern | B1 | B2 | B3 | B4 | B5 | B6 | B7 | scratch (excluded) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `opencode`/`OpenCode`/`OPENCODE` | 35,765 | 707 | 51,375 | 9 | 4,499 | 63,504 | 490 | 92 |
| `@opencode-ai/` | 4,536 | 339 | 5,344 | 0 | 449 | 446 | 221 | 26 |
| `horizoncode`/`HorizonCode` (already-correct) | 1,268 | 30 | 144 | 3 | 222 | 1,495 | 26 | 18 |
| `hzcode` (already-correct) | 12 | 0 | 32 | 0 | 21 | 82 | 2 | 0 |
| `oh-my-pi`/`OMP` | 13 | 0 | 129 | 0 | 53 | 24,269 | 0 | 0 |
| `codex`/`Codex` | 110 | 46 | 2,472 | 0 | 53 | 44,875 | 1 | 56 |
| `claude-code`/`anthropic` | 131 | 661 | 6,809 | 0 | 129 | 325,170 | 20 | 969 |
| `Cursor` (product, cased) | 238 | 1 | 321 | 0 | 50 | 4,346 | 0 | 15 |
| `cursor` (lowercase, non-identity) | 0 | 9 | 1,267 | 0 | 1 | 20,197 | 3,188 | 447 |
| `Devin` | 0 | 0 | 6 | 0 | 1 | 3,563 | 0 | 0 |
| `Windsurf` | 105 | 0 | 187 | 0 | 25 | 346 | 0 | 0 |

---

## 3. The provider-package boundary (KEEP — bucket 2)

### 3.1 Primary boundary — exactly what §20.16.1 maps (evidence-backed, no guessing)

| Path | Hits / files | Note |
|---|---:|---|
| `packages/opencode/src/provider/**` (`provider.ts`, `transform.ts`, `error.ts`, `auth.ts`, `model-status.ts`, `doctor.ts`, `digitalocean-catalog.ts`, `UPSTREAM.md`) | 100 / 8 | §20.16.1 rows 1–7 |
| `packages/opencode/src/auth/**` (`index.ts`, `provider-transport.ts`, `secret-broker.ts`, `credential-broker-runtime.ts`, `secret-service*.ts`, `secure-input.ts`) | 24 / 6 | §20.16.1 rows 8–10 |
| `packages/opencode/test/provider/**`, `packages/opencode/test/auth/**` | 231 / 23 | provider/auth acceptance |
| `packages/core/src/models-dev.ts`, `packages/core/src/plugin/models-dev.ts`, `packages/core/src/session/provider-request.ts` | (in B2) | §20.16.1 rows 11–13 |
| `packages/llm/src/**` (provider/model/protocol transport) | 9 opencode-hits / 8 files + 661 anthropic-hits | §20.1 "replaceable only through A-V2-27" |
| **Bucket 2 total** | **1,793 / 97** | |

**Deliberately adjacent but NOT in this boundary (vendor → bucket 3):**
`@gitlab/opencode-gitlab-auth`, `opencode-gitlab-auth`, `opencode-poe-auth` (npm vendor auth),
vendored `opencode-ai-client-1.17.13-v2.tgz` consumed by `packages/app` and `packages/session-ui`
(`bun.lock:40` and `:806`, `packages/session-ui/package.json:41`), `@ai-sdk/anthropic` and the other
`@ai-sdk/*` provider SDKs, `models.opencode.ai`, provider identities `opencode` (OpenCode Default)
and `opencode-go` (OpenCode Go) — §20.16.2 pins those two names explicitly.

**Deliberately outside (pinned → bucket 3):** the whole `opencode/**` snapshot (45,324 hits /
2,827 files). Never edited; §17.7 and §10.12 forbid rewriting it "to make the migration appear
complete".

### 3.2 Boundary question the parent must confirm (bucket 7)

"Provider package" is **not a defined identifier anywhere in `arch_V1/`** — `grep -rn "provider
package"` over `arch_V1/`, `docs/`, `reports/`, `HANDOFF.md` returns **zero matches**. Two readings
are possible and they differ by ~4,600 hits:

| Reading | Scope | Consequence |
|---|---|---|
| **A — narrow (recommended default)** | §3.1 paths only | `packages/opencode` package name `opencode`, its `@opencode-ai/*` deps, its CLI/TUI/session source and tests all remain MIGRATE targets → large but bounded work |
| **B — broad** | whole `packages/opencode/**` package (698 files / 4,636 opencode-hits), incl. `name:"opencode"`, `bun.lock` importer `opencode`, `turbo.json` `opencode#test`, `packages/web/package.json` `opencode: workspace:*` edge | package-scope migration stops at this package; upstream upgrade stays a clean `opencode/` → root overlay copy for the largest package |

P9's ledger (§14, §24) currently treats `packages/opencode`'s `name:"opencode"` as **MAPPED; NOT
MIGRATED** and part of the staged package layer. The user ruling may supersede that for this
package only. **Do not start Stage 2 (§8) until this is answered.**

Provider-adjacent adapters that §20.16.1 does *not* map and that move between B1 and B2 depending
on that answer: `packages/core/src/plugin/provider/**` (43 / 13 files, e.g. `opencode.ts` 20 hits)
and `packages/opencode/src/plugin/**` (86 / 21 files).

---

## 4. MIGRATE detail (bucket 1)

### 4.1 Totals by area (opencode-family hits, after line-level fact reassignment)

| Area | Hits | Files | Surface |
|---|---:|---:|---|
| `packages/web` | 18,170 | 642 | post-V1 web/docs |
| `packages/app` | 5,864 | 370 | post-V1 Solid app (mostly i18n) |
| `packages/opencode` | 3,277 | 633 | **V1 CLI/host** |
| `packages/console` | 2,177 | 134 | post-V1 console (i18n) |
| `packages/core` | 1,494 | 310 | **V1 Core** |
| `packages/stats` | 785 | 56 | post-V1 |
| `packages/sdk` | 687 | 18 | **generated client** (`openapi.json` 601) |
| root files | 607 | 31 | **V1 README/AGENTS/package/flake/install** |
| `packages/desktop` | 497 | 117 | post-V1 desktop |
| `packages/tui` | 423 | 159 | **V1 TUI** |
| `arch_V1` | 244 | 34 | architecture prose |
| `packages/session-ui` | 200 | 55 | post-V1 |
| `scripts` | 154 | 14 | **release/architecture tooling** |
| `packages/server` | 116 | 29 | **V1 server** |
| `specs`, `docs/superpowers`, `github`, `protocol`, `llm`, `script`, `nix`, `sdks`, `kernel`, `cli`, `.github`, … | 775 | ~260 | mixed |

**V1-shipped surfaces ≈ 14,034 hits; post-V1 surfaces (web/app/console/desktop/stats/ui/session-ui)
≈ 27,804 hits (66 %).** All are first-party under the ruling, but §20.17's staged order and A-V2-31
(post-V1 surfaces unavailable in V1) put them in the last stage.

### 4.2 Visibility of MIGRATE files (the practical blocker)

| Visibility | Files |
|---|---:|
| tracked (edit is visible immediately) | 594 |
| **hidden — ignored + untracked + byte-identical to pin** | **2,339** |
| untracked but visible | 3 |

Every hidden file needs an explicit `!` entry **before** it is edited, or the edit is invisible to
`git status` *and* `audit_overlay_visibility.py` fails with `hidden_changed>0`.

### 4.3 Top MIGRATE targets

**Single files (opencode-family hits after fact reassignment):**

| Hits | File | What it is |
|---:|---|---|
| 601 | `packages/sdk/openapi.json` | generated OpenAPI/client: `createOpencodeClient` ×376, `@opencode-ai/sdk` ×188 |
| 149 | `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap` | CLI help snapshots still assert `opencode <cmd>` usage |
| 139 | `packages/web/src/content/docs/providers.mdx` | product docs |
| 110 | `packages/web/src/content/docs/ecosystem.mdx` | product docs |
| 104 | `scripts/release/test_release_readiness.py` | release tooling (tracked) — most lines are compat/vendored assertions |
| 97 | `packages/web/src/content/docs/config.mdx` | product docs |
| 33 | `packages/opencode/package.json` | `name:"opencode"` — **bucket 7 decision** |
| 23 | `packages/core/src/plugin/provider/opencode.ts` | OpenCode Default provider plugin — provider-adjacent |
| 22 | `nix/opencode.nix` | derivation name |
| 9 | `packages/opencode/src/index.ts` | `.scriptName("opencode")` + `text.startsWith("opencode ")` — **user-visible CLI name**, hidden+identical-to-pin |

**File groups (locale/i18n families — one mechanical edit each, multiplied):**

| Hits | Files | Note |
|---:|---:|---|
| 17,949 | 614 | `packages/web/src/content/docs/**` (21 locales; 139 max/file) |
| 4,443 | 63 | `packages/app/src/i18n/*` (74 max/file) |
| 1,740 | 18 | `packages/console/app/src/i18n/*` (97 max/file) |
| 646 | 17 | `packages/stats/app/src/i18n/*` |
| 198 | 18 | `packages/web/src/content/i18n/*` |
| 188 | 63 | `packages/desktop/src/renderer/i18n/*` |

*Excluded from this MIGRATE list on purpose:* `.gitignore` (500 hits = 487 `opencode` + 13
`HorizonCode`) is **entirely bucket 5** — every occurrence is a factual overlay path, not identity.

**Highest-value V1 MIGRATE targets found (concrete, not aggregate):**

1. `packages/opencode/src/index.ts:47` `.scriptName("opencode")` and `:37` `startsWith("opencode ")`
   — the CLI still *renders* as `opencode` although `package.json` bins are
   `horizoncode`/`hzcode` → `./bin/horizoncode`.
2. `packages/opencode/src/cli/ui.ts` ASCII wordmark (logo printed on non-upstream-prefixed output) —
   needs visual verification that it does not spell the old product name.
3. `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap` (149) — will fail as
   soon as (1) changes; regenerate in the same commit.
4. `packages/sdk/openapi.json` + `packages/sdk/js/src/v2/gen/*` (42+14) — generated client IDs.
5. `packages/client/src/generated*/`, `packages/client/src/contract.ts` — already migrated by P9
   (`@horizoncode/client`), assert-only.
6. `nix/opencode.nix` (22) + `flake.nix` (12) — P9's open finding `default = opencode` (untested,
   `nix` absent here).
7. `.github/workflows/horizoncode-release-qualification.yml` (7) — already correct; contrast with
   the 22 upstream-identical workflows in bucket 7.
8. `scripts/release/*.py` (139+30+10+9+…) — release fixtures already carry both aliases; keep the
   legacy-override negative test (`test_horizoncode_binary_override_precedes_legacy_opencode_override`).

### 4.4 `horizoncode` / `hzcode` current state (informational, no work)

`horizoncode|HorizonCode|HORIZONCODE` **3,206 hits / 442 files**; `hzcode` 149 hits / 49 files.
Already correct in: root `package.json` (`name: horizoncode-workspace`, `horizoncode:typecheck`),
`packages/opencode/package.json` bins, `install` (`COMMAND=horizoncode`, `ALIAS=hzcode`),
`packages/client`, `packages/sdk-next`, `kernel/**` (405 hits), `scripts/release/**`,
`.github/workflows/horizoncode-*.yml`, `README.md`.

---

## 5. KEEP — upstream/vendor (bucket 3) and legal (bucket 4)

**Bucket 3 = 68,086 hits / 4,032 files**, composition:

- `opencode/**` pinned snapshot: 45,324 / 2,827 — immutable per §17.7.
- Line-level upstream facts inside first-party files: source paths `packages/opencode/**`,
  `opencode/**`, provenance prose (`pinned OpenCode base`, `OpenCode-derived`, `upstream OpenCode`),
  `https://…opencode.ai`, `anomalyco/opencode`, npm `opencode-ai`, `models.opencode.ai`,
  `opencode-go` / `OpenCode Default` provider IDs, vendor auth packages, vendored client tarball
  IDs (`@opencode-ai/client` in `packages/app`, `packages/session-ui`, `bun.lock`).
- `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` (91), `arch_V1/opencode-b1fe25ab-path-inventory.jsonl`
  (931), `arch_V1/ignored-reference-source-manifest.json` (2 codex-count files), `external-source-register.json`.
- Genuine provider/vendor tokens in code and fixtures: `packages/opencode/test/tool/fixtures/models-api.json`
  (700 anthropic + 498 codex + …), `packages/llm/src/protocols/anthropic-messages.ts` (44),
  `@ai-sdk/anthropic` references, `packages/docs/ai-tools/*` (Mintlify docs about Cursor/Claude Code/Windsurf).

**Bucket 4 = 19 occurrences / 11 files — NEVER change:**

`LICENSE` (2 `OpenCode` + 1 `HorizonCode`-in-legal-text), `NOTICE` (5 + 2), `packages/ui/LICENSE`
(1, `Copyright (c) 2025 opencode`), `packages/http-recorder/LICENSE` (1, same copyright) — 12
auto-counted — plus line-level: `CONTRIBUTING.md:53`,
`arch_V1/17:147` (DEC-V1-11), `arch_V1/10:157`, `arch_V1/18:392`, `arch_V1/42:431`,
`packages/core/src/session/transfer.ts:6` (copyright header),
`packages/console/app/src/routes/legal/terms-of-service/index.tsx:356` ("the OpenCode Parties").
`packages/docs/LICENSE` is `Copyright (c) 2023 Mintlify` (vendor, no identity string).
This list is a **minimum** — a dedicated legal-line sweep is a separate, separately-gated pass.

---

## 6. KEEP — factual compat/config (bucket 5) and research/evidence (bucket 6)

**Bucket 5 = 5,503 hits / 709 files.** Notable entries:

- `OPENCODE_*` env contract read by the product/tooling: `OPENCODE_DISABLE_SHARE` (`turbo.json`),
  `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
  `OPENCODE_PORT` (`sdks/vscode/src/extension.ts`), `OPENCODE_PRINT_LOGS|OPENCODE_LOG_LEVEL|
  OPENCODE_PURE` (`packages/opencode/src/index.ts`), `OPENCODE_EXPERIMENTAL` (arch §20 table),
  `OPENCODE_INSTALL_DIR` in all 23 translated READMEs.
  *Already superseded by first-party names (keep both as tested aliases):* `HORIZONCODE_INSTALL_DIR`,
  `HORIZONCODE_BIN_PATH` vs legacy `OPENCODE_BIN_PATH`.
- Path contracts: `packages/opencode/**`, `opencode/**`, `~/.opencode/bin` (installer default),
  `.opencode/` project config dir, `--sso-session=opencode` (AWS CLI session name in root
  `package.json` — renaming forces a one-time `aws sso login` re-auth).
- `.gitignore` (500 hits) — every `!/packages/opencode/**` style overlay entry is a factual path.

**Bucket 6 = 488,293 hits / 16,853 files:**

- `repo_take/**` 48,233 / 3,788 (incl. `repo_take/opencode`, `repo_take/oh-my-pi`, `repo_take/jcode`).
- `repos/**` opencode-pattern 349 / 112 files; `codex` there alone is 25,358 / 3,286 (reference
  clones `cline`, `codex`, `deepseek-harness`).
- `docs/architecture-archive/**`, `docs/architecture-input/**`, `docs/audits/**`,
  `docs/research/**`, `docs/performance/**`, `docs/audit-markdown-latest.json`.
- `reports/**` 1,613 / 45 (phase reports, `reports/research/*`).
- Status/evidence logs: `CURRENT_RUN.md` (372), `HANDOFF.md` (240),
  `implementationtov1release.md` (225), `.horizon_arch_review.txt` (137).
- `arch_V1` audit/provenance JSON + OMP chapters 38–41 and 19.

**Competitor-name result (NAME-003):** a targeted scan of *user-visible product strings*
(`packages/*/src/i18n`, `packages/console/app/src/i18n`, `packages/tui/src`,
`packages/opencode/src/cli`, `packages/opencode/src/index.ts`) for
`Cursor|Claude Code|Windsurf|Devin|Codex` returned **zero matches**. Every remaining competitor
mention is a factual comparison (`arch_V1/17:105`, `arch_V1/10:232,240`,
`arch_V1/31.22` "Cursor-informed", `arch_V1/32:1328`), an integration doc
(`packages/web/.../tui.mdx:338-339` `cursor`/`windsurf` editor detection,
`packages/docs/ai-tools/*.mdx`), or research (`reports/research/competitors-cursor-devin.md` 155).

**OMP / Oh My Pi result:** 24,464 hits total, of which 24,269 are `repo_take/`; **zero** occurrences
of `omp|oh-my-pi|Oh My Pi` anywhere under `packages/`, `kernel/`, `scripts/`. The 13 B1 hits are
prose in `docs/superpowers/plans` / `arch_V1` that name OMP as an adopted reference → research
wording, not product identity.

---

## 7. Bucket 7 — could not classify (needs an explicit decision)

| # | Item | Hits / files | Question |
|---|---|---:|---|
| 7.1 | `packages/opencode/package.json` `name:"opencode"` (33) + `bun.lock` importer `opencode` (472) + `turbo.json` `opencode#test` (13) + `packages/web/package.json` `opencode: workspace:*` (4) | **522 / 4** | Reading A (§3.2) → MIGRATE; reading B → KEEP. **Atomic: all four move together or not at all.** |
| 7.2 | 22 upstream-identical `.github/workflows/*` (`publish.yml` 140, `duplicate-issues.yml` 16, `docs-locale-sync.yml` 15, `opencode.yml` 10, `review.yml`, `test.yml`, `triage.yml`, …) and their `secrets.OPENCODE_API_KEY` / `OPENCODE_APP_ID` / `OPENCODE_APP_SECRET` / `OPENCODE_CHANNEL` / `OPENCODE_VERSION` | **238 / 22** | Dormant upstream CI (only `horizoncode-*.yml`, `containers`, `nix-hashes`, `publish-*`, `publish` are tracked). Renaming a secret requires a **GitHub repository-settings change outside this repo** — separate authorization. |
| 7.3 | Non-identity `cursor` tokens (`CursorV1`, `RepoStructureCursorLeaseV1`, TUI/text/SQL cursors, `packages/ui/src/theme/themes/cursor.json`, `.cursor/rules.md` in vendored docs) | **3,188 / 538** | Not product identity at all — recommend recording as "no action" rather than migrating. |
| 7.4 | Provider-adjacent adapters not mapped by §20.16.1: `packages/core/src/plugin/provider/**` (43/13), `packages/opencode/src/plugin/**` (86/21) | 129 / 34 | Follows from 7.1: inside the provider package (KEEP) or first-party (MIGRATE)? **Currently counted as B1.** |
| 7.5 | `install:104` `${HORIZONCODE_INSTALL_DIR:-$HOME/.opencode/bin}` | 1 | Keep the legacy default dir (compat, P9's `app`/`desktop` WSL probes read `$HOME/.opencode/bin/opencode`) or move to `~/.horizoncode/bin` with a NAME-004 compat test? |
| 7.6 | `sdks/vscode/**` (33) and `github/**` (66) | 99 / 10 | Upstream-identical VS Code extension + GitHub Action. Extension IDs (`anomalyco.opencode`-style) are store-bound; renaming is a *distribution* act → separately gated. |

Manual adjustments I recommend but did **not** apply to the totals (to keep them reproducible):
move 7.4 (129 hits) B1→B2 if reading B wins; move the 7 line-level legal occurrences (§5) B1→B4
(≈ B1 42,178 → 42,171; B4 12 → 19).

---

## 8. Staged migration order (dependency-mapped) and how each stage is validated

> Each stage is a bounded, atomic layer per §20.17.1 step 2. Never overlap active phase typecheck
> inputs (P1 server/supervisor, P7 TUI, P8 scripts+kernel tests are writing concurrently).

**Stage 0 — decisions (no code).** Answer 7.1 (provider-package scope), 7.2 (secrets/external
config), 7.5 (install dir), and confirm whether post-V1 surfaces (66 % of MIGRATE hits) ride this
V1 exit or are staged later. *Validated by:* an explicit parent decision recorded in the operative
tracker — nothing else.

**Stage 1 — `.gitignore` visibility prep (MUST precede every edit).** Add `!` entries for every
directory/file that Stage 2–5 will touch (exact list in §9). *Validated by:*
`python3 scripts/architecture/audit_overlay_visibility.py` (expect `hidden_changed=0`,
`hidden_new_source` back to the 3-file baseline after owners fix theirs),
`git check-ignore -v <each new/renamed path>` shows a `!` rule, `git status --porcelain` shows the
new/renamed file as `??`/`R`.

**Stage 2 — package metadata / workspace edges / lockfile.** Rename the 33 first-party
`@opencode-ai/*` package IDs (see §8.1) — **excluding** vendored `@opencode-ai/client` — atomically
with `bun.lock` importer names, workspace resolutions, root `package.json` deps, and (per 7.1)
`turbo.json` task keys + the `packages/web` edge.
*Validated by:* `bun install --frozen-lockfile --offline` (or `--lockfile-only --offline`),
`python3 scripts/architecture/audit_workspace_packages.py`,
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts.release.test_release_readiness -v`
(guarded tests: `test_local_client_identity_does_not_shadow_the_vendored_opencode_client`,
`test_workspace_lockfile_importers_match_manifest_identity`, dual-command install/upgrade negatives),
`git diff -- bun.lock` shows only identity rows.

**Stage 3 — import aliases + generated clients.** Rewrite every `@opencode-ai/<pkg>` import
specifier in source/tests/fixtures; regenerate `packages/client/src/generated*`,
`packages/sdk/openapi.json` and `packages/sdk/js/src/v2/gen/*`.
*Validated by:* per-package `bun run --cwd packages/<pkg> typecheck` (targeted, **not**
package-wide), `bun test packages/client/test/import-boundaries.test.ts`,
`packages/sdk-next/test/import-boundaries.test.ts`,
`cd packages/opencode/test/identity && HOME=<repo-scratch> TMPDIR=<repo-scratch> bun test runtime-service-identity.test.ts`
(2 pass / 57 expectations), then `bun run --cwd packages/client typecheck` (exit 0) and
`bun run --cwd packages/sdk-next typecheck`.

**Stage 4 — CLI / build / typecheck / workflow identity.** `src/index.ts` `scriptName` + help
snapshot regeneration, `nix/opencode.nix`/`flake.nix` derivation name, containers/Docker entrypoints,
`scripts/release/*` fixtures, `.github/workflows/*` product identity (not secrets — 7.2),
`specs/**`, `kernel/**` references.
*Validated by:* `bash -n install`, `bun run horizoncode:typecheck`,
`bun turbo typecheck` (full typecheck at this stage only, per §10.12),
`python3 scripts/release/audit_distribution.py --root .`,
`python3 scripts/release/release_gate.py --root .`,
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts.release.test_release_readiness -v` (≥82/82),
workflow YAML parse, `bun run --cwd packages/opencode build` → artifact `horizoncode`.

**Stage 5 — first-party non-legal prose.** Root `README.*.md` translations (23 files), package
`AGENTS.md`/`README.md`, `packages/web/src/content/docs/**`, i18n product strings,
`docs/superpowers/**`, `arch_V1` prose where it names *our* product, `CONTEXT.md`.
*Validated by:* `python3 scripts/architecture/audit_markdown_repo.py`,
`python3 scripts/architecture/validate_convergence.py`, plus a NAME-003 grep audit asserting
competitor names are absent **as product identity** while legal/attribution/provenance lines
(§5) remain byte-identical.

**Stage 6 — V1 identity exit (NAME-001..004) on one exact candidate revision.**
Full `horizoncode:typecheck`; Linux candidate build + clean install + **both** `horizoncode` and
`hzcode` journey; frozen-lockfile resolution on a clean checkout; NAME-004 rollback of Stage 2
(package graph restored, no second runtime); distribution audit; markdown + convergence audits.
*Naming exit may only be declared VERIFIED with all four NAME rows evidenced on that revision.*

**Stage 7 (post-V1 unless promoted) — web/app/console/desktop/stats/ui/session-ui surfaces**
(≈ 27,804 hits). These are still first-party under the ruling, but A-V2-31 keeps the surfaces out
of V1; each edit also converts an upstream-identical hydration copy into a maintained delta.

### 8.1 Stage 2 rename inventory (33 first-party IDs still `@opencode-ai/*`)

`app, cli, codemode, core, desktop, effect-drizzle-sqlite, effect-sqlite-node, enterprise, function,
http-recorder, httpapi-codegen, llm, plugin, protocol, schema, script, server, session-ui, slack,
stats-app, stats-core, stats-server, storybook, tui, ui, web, console-app, console-core,
console-function, console-mail, console-resource, console-support, sdk`
— **34th name in the manifests is `@opencode-ai/client`, the vendored tarball: preserve.**
Already migrated by P9: `@horizoncode/client`, `@horizoncode/sdk-next` (+ `bun.lock` importer rows
and `packages/opencode` bins).

---

## 9. The `.gitignore` blanket-`*` trap

The root `.gitignore` starts with `*` and then unignores **1,140 specific paths** against only 36
positive ignore rules. Consequences measured for this audit:

- **2,339 of the 2,936 MIGRATE files are invisible to `git status` today** (hidden, untracked,
  byte-identical to the pin). Editing any of them produces a *silent* omission until
  `audit_overlay_visibility.py` fails with `hidden_changed>0` (exactly the P9 `runtime.boot.test.ts`
  episode recorded in `reports/phases/LEDGER.md`).
- A *renamed* file loses its visibility even if the old path was tracked: the destination directory
  must already be allowlisted.

**Directories that will need a new `!` entry before Stages 1–5 touch them** (minimal set — any rule
whose ancestor is listed is redundant; each implies `!/dir/**`):

```
!/.github/ISSUE_TEMPLATE/**          !/packages/console/app/**        !/packages/opencode/**
!/.github/actions/setup-git-committer/**  !/packages/console/core/**   !/packages/plugin/**
!/.vscode/**                         !/packages/console/function/**   !/packages/protocol/**
!/github/**                          !/packages/console/mail/**       !/packages/schema/**
!/infra/**                           !/packages/console/resource/**   !/packages/script/**
!/packages/app/**                    !/packages/console/support/**    !/packages/sdk-next/src/**
!/packages/cli/**                    !/packages/core/**               !/packages/sdk/js/**
!/packages/client/**                 !/packages/desktop/**            !/packages/server/**
!/packages/codemode/**               !/packages/docs/**               !/packages/session-ui/**
                                    !/packages/effect-drizzle-sqlite/**  !/packages/slack/**
                                    !/packages/effect-sqlite-node/** !/packages/stats/**
                                    !/packages/enterprise/**         !/packages/storybook/**
                                    !/packages/function/**           !/packages/tui/**
                                    !/packages/http-recorder/**      !/packages/ui/**
                                    !/packages/httpapi-codegen/**    !/packages/web/**
                                    !/packages/llm/**                !/patches/**
                                                                     !/perf/**
                                                                     !/script/**
                                                                     !/sdks/vscode/**
                                                                     !/specs/**
```
(45 rules total; 397 directories are affected before minimisation.)

**Root-level hidden MIGRATE files needing individual `!` entries (24):**
`!/.dockerignore`, `!/bunfig.toml`, `!/sst.config.ts`, and the 21 translated READMEs
`!README.{ar,bn,br,bs,da,de,es,fr,gr,it,ja,ko,no,pl,ru,th,tr,uk,vi,zh,zht}.md`.

**Safety notes for whoever edits `.gitignore` (not me):**

1. **Order matters.** A `!/packages/opencode/**` placed *after* the `node_modules` rule would
   re-include `packages/opencode/node_modules`, `dist/` and test-data trees. Place identity
   negations **before** the `node_modules`/`target`/`dist` rules, or re-assert those ignores
   afterwards, then prove it: `git check-ignore -v packages/opencode/node_modules/x` must still
   report an ignore rule.
2. **Prefer narrow entries** (P9's pattern: `!/packages/opencode/test/cli/run/runtime.boot.test.ts`)
   over package-wide `/**` for the 31 hidden package manifests: `!packages/<pkg>/package.json`
   covers Stage 2 without exposing the other hidden upstream copies.
3. The **broad `!/packages/opencode/**` above should not be used as-is** — it is listed only because
   Stage 4 must touch several `packages/opencode` files; add those exact paths instead.
4. This report file is visible only because `!/reports/*.md` already exists (line 1250) — a good
   live example of why the trap matters.

---

## 10. What I could not determine

1. Whether "the provider package" means §3.1's mapped roots (narrow) or the whole
   `packages/opencode` package (broad) — **no document defines the term**; ~4,636 hits and 4
   coupled manifest/lock edges differ. Bucket 7.
2. Whether GitHub `secrets.OPENCODE_*` are still provisioned (external repo settings, cannot be
   read read-only from here) and whether renaming them is authorized.
3. Whether the `packages/opencode/src/cli/ui.ts` ASCII wordmark encodes the old product name
   (needs rendering; no code change attempted).
4. Whether the 21 translated root READMEs and `packages/web/src/content/docs/**` are in the V1
   identity exit or deferred with their post-V1 surfaces (66 % of all MIGRATE hits).
5. Nix: `nix`/`nix-instantiate` absent here, so `flake.nix`/`nix/opencode.nix` identity could not
   be evaluated (P9's open finding `default = opencode` stands, untested).
6. `sdks/vscode` and `github/**` extension/action IDs — store/registry-bound; renaming is a
   distribution act and is separately gated (DEC-V1-11/12).

---

## 11. Commands run for this audit (all read-only)

```bash
rg --no-ignore --hidden --count-matches -e '<pattern>' \
   -g '!node_modules/**' -g '!.git/**' -g '!target*/**' -g '!**/dist/**' -g '!.tmp*/**' \
   -g '!tmp/**' -g '!hz-t/**' -g '!**/*.log' -g '!.p1*/**' -g '!.p6-e2e/**' -g '!.p7*/**' ...
python3 scripts/architecture/audit_overlay_visibility.py   # exit 0: hidden_changed=0, hidden_new_source=3
git ls-files -z / git check-ignore --stdin -z              # tracked vs hidden per file
cmp -s <root overlay> opencode/<same path>                  # identical-to-pin test per file
git check-ignore -v <report path>                          # proves the ! trap behaviour
```

**No file was edited, no Git state changed, no build/typecheck/package-wide check run.**
