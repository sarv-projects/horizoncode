# HorizonCode Linux release tooling

This directory contains fail-closed source preparation, distribution inventory,
and install-evidence tooling. It does not publish packages, select a license,
approve a signing root, or establish platform support on its own.

## Local artifact boundary

Generated release inputs and evidence belong under the ignored repository-local
`kernel/target/horizoncode-release/` directory. Keep the copied source checkout,
candidate binaries, and evidence roots as separate children. The source snapshot
excludes every `target/` subtree, so prior local artifacts do not contaminate the
next source digest or checkout. The runner rejects reused evidence directories,
symlinked roots, dirty candidate checkouts, and candidate paths outside their
checkout.

Build preparation also puts its private HOME, Cargo home, and Rustup home inside
this artifact subtree. It does not inherit the invoking user's Rustup state;
it installs the stable Rust toolchain into that isolated Rustup home before
building and records the resolved compiler version in the candidate manifest.

The manually dispatched GitHub qualification workflow stores its build copy
and reports in this same repository-local artifact subtree. Building that copy
uses the pinned lockfiles with `cargo fetch --locked` and `bun install
--frozen-lockfile`, so a future workflow run needs read access to the
corresponding dependency registries. This is dependency acquisition only: the
workflow has read-only repository permissions and does not sign, publish,
upload, or activate an update.
Its summary is written under the per-run artifact directory and printed to
the job log; it does not write through the runner's external summary or
environment-file paths.

The pinned upstream snapshot under `opencode/.github/workflows/` is preserved
for provenance. Root workflows with inherited VS Code, GitHub Action, container,
and Nix hash publication behavior are HorizonCode-owned disabled overlays under
`.github/workflows/`; each has only a manual trigger, read-only permissions,
and an unconditional false job guard. `.gitignore` contains exact exceptions
for these five files so the overlays are Git-visible and the pinned snapshot
remains untouched. `packages/opencode/script/publish.ts` is a first-party
fail-fast entrypoint; it does not import the upstream publisher. The container
builder keeps host-architecture local image builds but rejects `--push` and
`PUSH=1` before any Docker command. The distribution audit treats missing or
enabled workflow overlays and missing direct-entrypoint guards as release
blockers. Do not restore publication jobs or push behavior: although first-party
MIT is selected, exact third-party notice closure and candidate acceptance remain
open, and signing/update policy is deferred beyond V1.

Release source, candidate checkout, install fixtures, and JSON evidence outputs
are constrained to paths inside this repository. The helpers reject external
source/evidence paths before opening them and refuse to replace an existing
evidence file. Evidence manifests are created with no-follow, exclusive file
creation through pinned repository-local directory descriptors. Before the
isolated upstream build removes generated output, it checks the marker, owner,
permissions, symlink components, and ownership of the complete removal tree.

The normal installer path intentionally accepts only a local executable via
`install --binary <candidate> --sha256 <expected-digest>`. The SHA-256 digest is
required and checked before install state is created, then checked again against
the staged copy before activation; supported Linux ELF/script-interpreter
architecture must match the host. This checksum is integrity against the
operator-supplied digest, **not a signature or proof of origin**. Remote artifact
download, signatures, and automatic updates remain unavailable under DEC-V1-12;
the CLI reports that state rather than starting a package-manager process.
`horizoncode` and `hzcode` install from the same candidate entrypoint.
`install --binary ... --sha256 ... --dry-run` validates the digest, architecture,
destination, and planned aliases without creating directories, copying files,
or editing shell profiles. `scripts/release/clean_install.py --dry-run` and
`scripts/release/prepare_build.py --dry-run` provide the corresponding
input/isolation and isolated-build validation only.

Each built candidate carries the first-party MIT `LICENSE` and root `NOTICE`.
The notice preserves the known OpenCode attribution and explicitly records
that third-party dependency/native-asset notice closure still requires exact
candidate inspection. The copyright holder/year for HorizonCode first-party
work is not invented; the existing upstream statement is preserved. User
decision 2026-10-25 resolves the first-party grant (DEC-V1-11), but does not
clear incomplete third-party closure or authorize publication by itself.

## Candidate build commands (item 48)

Dry-run validation, safe on any tree, creates nothing:

```text
PYTHONPATH=. python3 scripts/release/prepare_build.py --source . \
  --destination kernel/target/horizoncode-release/p9-dry-run --dry-run
```

The exact real candidate command, **ready to run only after the parent relays
Phase-10 acceptance** (it installs locked dependencies and compiles):

```text
PYTHONPATH=. python3 scripts/release/prepare_build.py --source . \
  --destination kernel/target/horizoncode-release/<revision>-candidate --build
```

Do not run the real command while the source tree is dirty, while P1–P8
integration is incomplete, or before Phase 10 is accepted; the preparer marks
such builds `NON_RELEASE_QUALIFIED`. The stale `packages/opencode/dist` tree is
never a candidate input.

## Legal-file evidence rules (item 8 and item 49)

Declared license metadata still comes only from a package's own manifest. A
runtime dependency row is cleared only when the package ships a direct
LEGAL_BASENAME file, or when a root-level file inside that package carries the
*complete* canonical grant text for the identifier that package itself
declares. The text channel hashes the exact bytes and records them under
`license_text_files` (see `grant_text_without_dedicated_license_file`), so
nothing is cleared silently. A mismatched grant, a component-scoped nested
file, or a package with no declared metadata never closes: `seq-queue@0.0.5`
ships MIT text but declares no license field, and `@openauthjs/openauth` and
`poe-oauth` ship no local grant at all; all three stay named blockers.

Candidate legal files are content-validated, not just name-validated: the
artifact LICENSE must carry the selected first-party MIT grant text and the
artifact NOTICE must preserve the OpenCode copyright/license attribution.
Missing or weak content is an explicit release blocker. The inspected artifact's
legal files must additionally be byte-identical to the tracked repository
`LICENSE`/`NOTICE` that the isolated build packages, so a candidate whose legal
files silently differ from the reviewed root files is blocked even when the
content predicates pass.

## Promoted canonical license texts (item 8, second pass)

`scripts/release/notice-texts/` holds byte-exact copies of canonical license
bodies promoted from locally installed packages, and
`scripts/release/notice-texts-provenance.json` records, per text, the source
package path, source digest, byte-identical copy count, byte count and the
closure rule. A promoted text closes a dependency row only when:

- the grant is in `CANONICAL_TEXT_GRANTS` (currently only `Apache-2.0`, whose
  canonical body carries no package-specific copyright line);
- the row's own manifest declares that grant token (case-insensitive; an SPDX
  expression such as `MIT OR Apache-2.0` matches on its Apache token);
- the stored bytes still hash to the recorded provenance digest;
- the text carries the complete canonical marker set **and** all 11 structural
  markers (license header, sections 1-3/8/9, END OF TERMS, APPENDIX template).

MIT and ISC rows never close from promotion because their artifact notice must
retain the installing package's own copyright line, which is not available
locally. A missing, truncated, tampered, or out-of-root text is dropped, so the
dependent rows stay blocked; the three license-metadata gaps
(`seq-queue@0.0.5`, `@openauthjs/openauth`, `poe-oauth@0.0.8`) are unaffected and
their vendor manifests are never edited. Promoted-text closure is exact-text
availability for the declared grant; it is not third-party legal clearance.

## Stage-2 identity and clean-machine plans (items 50/51)

`scripts/release/IDENTITY-MAPPING.json` is the NAME-001..004 mapping plan: it
classifies every workspace package as MIGRATE, DONE, or vendor HOLD, records
each MIGRATE row's lockfile edges, source-importer coupling, generated
identifiers and runtime identifiers, and lists the vendor/upstream identities
that must never be renamed. A regression test recomputes the workspace set and
the importer-coupling facts, so the plan cannot drift from the manifests.

`scripts/release/CLEAN-MACHINE-PLAN.json` is the clean-machine
install/upgrade/migration/rollback test plan. Every scenario stays `NOT_RUN`
until a real digest-bound run is authorized; the plan forbids reusing stale
legacy output, forbids remote download, and keeps Linux/WSL `NOT_VERIFIED` and
native Windows `UNAVAILABLE`.

## Candidate discovery and first-party notice evidence

Without an explicit `--artifact`, the distribution audit selects exactly one
candidate: a `packages/opencode/dist/<target>/bin/horizoncode` product binary
(whose `bin` directory is the artifact root, holding `release-manifest.json`,
`LICENSE` and `NOTICE`), or a single package-root archive. More than one match
is reported as ambiguous and requires `--artifact`; the audit never picks one
silently. Output produced before the product-binary rename has no
`bin/horizoncode`: it is classified `STALE_LEGACY`, reported as a blocker, and
still inspected fail-closed so its missing legal files, inventory and
provenance remain visible. Stale output is never merged into a candidate's file
inventory, so leftovers cannot fail a future valid candidate — and cannot
substitute for one.

Declared license metadata comes only from the package's own manifest,
including the deprecated npm `licenses` form; files on disk never fabricate a
license field, and a package that declares nothing stays blocked whatever sits
next to it. A first-party workspace package whose manifest declares exactly the
decided root grant (currently `MIT`) is recorded under
`first_party_workspace_grant_evidence` — covered by the tracked, vendor-distinct
repository-root `LICENSE` and `NOTICE` — instead of counting as a missing direct
file; every other package still needs its own direct LICENSE/NOTICE file.
Workspace manifest licenses that deviate from the root grant are reported as
facts for review, never cleared by this tool.

The manually dispatched qualification workflow first runs `bash -n install`,
the synthetic release-tooling failure-path suite, and both dry runs on a read-only
checkout. It then builds an isolated candidate, runs the real local installer and
TUI smoke in a bubblewrap network-isolated home, and records the release gate.
Without a previous release artifact, the install matrix is explicitly `PARTIAL`,
not a release pass.

## Platform status

| Lane | Current source status |
|---|---|
| Native Linux | Acceptance pending; not verified |
| WSL / WSL2 | Separate acceptance pending; not verified as native Windows |
| Native Windows | Unavailable |
| macOS | Outside V1 scope |

An install-matrix result for one candidate is evidence for that exact checkout,
artifact digest, and observed Linux/WSL lane. It does not establish the full
platform capability matrix or a release. Native Windows cannot be promoted by
WSL evidence.

The matrix pins candidate and previous-binary SHA-256 digests before the first
scenario. Each local install checks the input digest before invocation, the
installed executable digest afterward, and the input digest again after the
copy. A changed artifact fails that scenario instead of being attributed to
the originally reported candidate. The release-gate tooling digest inventory
includes the isolated build preparer as well as the audit, install runner, and
gate entrypoint.

Each isolated build writes a versioned `release-manifest.json` beside the
candidate binary. Version 2 binds the candidate to the source commit and
source-state digest, records pre/post-build source cleanliness, hashes both
lockfiles, records the actual Bun/Cargo/Rust compiler versions and build host,
and includes config migration IDs plus a digest of the V2 contract set. It also
lists every generated candidate file except the manifest itself, with its size
and SHA-256. Symlinks,
non-regular members, and inventories above 10,000 files or 4 GiB fail closed.
The manifest is provenance evidence; it does not claim byte-for-byte
reproducibility, license clearance, a signature, or release approval.
The distribution inspector accepts only schema 2, verifies the manifest's
pre/post-build source digest is unchanged, and checks exact candidate membership,
per-file sizes and hashes, and the named binary size before treating its
provenance inventory as valid.

The distribution audit bounds package-manifest reads to 2 MiB, each dependency
manifest to 4,096 declared dependencies, dependency traversal to 10,000
packages, each package legal-file scan to 8,192 directory entries, and those
scans to 100,000 entries total. It refuses symlinked dependency-manifest paths
and treats incomplete, oversized, or out-of-root inventory as an audit blocker
rather than reporting a partial closure as complete. This remains a
workspace-manifest inventory, not proof of the exact packaged dependency
closure; final candidate inspection is required.

The standalone installer prepares the candidate and command alias before it
replaces the current installation. It preserves a local recovery copy of the
previous canonical command until both public command names activate. If alias
activation fails after canonical replacement, it restores the prior canonical
command and reports a recovery path if that restoration itself fails. This is
a local install recovery behavior; it does not define a signed update channel
or a supported remote rollback policy.

## Remaining release gates

These are explicit decisions or evidence tasks, not decisions the release
scripts can make:

| Gate | Required decision/evidence | Current consequence |
|---|---|---|
| Distribution rights | User decision 2026-10-25 selects MIT for HorizonCode first-party distribution. Preserve upstream/vendor notices and inspect the exact transitive dependency/native-asset closure; do not invent copyright holder/year. | First-party grant is recorded; distribution remains blocked until exact artifact notice/license closure and candidate acceptance. |
| Product/package identity | Confirm the Linux V1 artifact identity and publication target. Architecture §18.16 already specifies canonical `horizoncode`, with `hzcode` as its alias, and says to retain vendor package identifiers until dependency/build/license/migration checks pass. The workspace is `horizoncode-workspace`; the derived CLI package remains private `opencode`. | No npm/public package identity or rename is inferred. Local candidate commands remain `horizoncode` and `hzcode`. |
| Signing and updates | User decision 2026-10-25 defers signing/update policy beyond V1. | Signing, remote install and automatic updates remain unavailable; no trust root or update rollback channel is configured. |
| Platform claims | Decide claimed Linux distributions/architectures and separately qualify native Linux and each WSL lane. Native Windows support requires its own implementation and acceptance; WSL is not evidence for it. | Linux/WSL are not verified; native Windows is unavailable; macOS remains out of scope. |
| Exact candidate acceptance | Produce a clean exact-revision candidate and separately run Linux and WSL clean install, config migration, TUI, upgrade, rollback, platform-capability, and full V1 gates. Bind evidence to source revision and artifact digest. | No release or supported-platform claim. |

The repository-only implementation session cannot contact a signing service,
package registry, legal authority, or remote Git host. No release/build/test
command has been run for this source revision. Update these gates only from
explicit product/legal decisions or exact-candidate acceptance evidence.

Current gate output is therefore readiness evidence or a blocker report, never
publication authorization.
