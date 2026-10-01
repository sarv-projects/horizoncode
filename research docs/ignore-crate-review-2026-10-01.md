# `ignore` crate review for recursive workspace search

Reviewed on 2026-10-01 for AX-004. HorizonCode pins `ignore` 0.4.33 as a normal
Rust library dependency. The package declares `Unlicense OR MIT`; both identifiers
are already in HorizonCode's SPDX allowlist. No upstream source is copied.

## Exact references

- [Versioned `WalkBuilder` API](https://docs.rs/ignore/0.4.33/ignore/struct.WalkBuilder.html)
- [Versioned walker source](https://docs.rs/crate/ignore/0.4.33/source/src/walk.rs)
- [Versioned crate metadata](https://crates.io/crates/ignore/0.4.33)
- [Versioned ignore-file matcher API](https://docs.rs/ignore/0.4.33/ignore/gitignore/index.html)

## Findings used by HorizonCode

- `WalkBuilder` can explicitly disable parent-directory, global Git, and
  `.git/info/exclude` sources while enabling local `.ignore` and `.gitignore`
  files and including hidden entries. `require_git(false)` is necessary for
  selected roots whose local `.gitignore` exists without a discovered Git marker;
  `parents(false)` still prevents reading rules above the selected root.
- `filter_entry` runs before the walker loads a traversed directory's own ignore
  files. HorizonCode uses that ordering to check the directory and its local
  ignore-file paths against the resolved confinement profile first.
- Ignore parse/build errors are attached to `DirEntry::error()`; they are not
  necessarily yielded as `Walk` iterator errors. HorizonCode converts either
  form to a typed tool failure.
- Some ignore-file I/O errors are suppressed by the walker. HorizonCode
  therefore opens and reads each present local ignore file before the walker
  uses it, with the same confinement check and a 1 MiB per-file limit.
- The walker does not follow symlinks. HorizonCode also refuses symlink ignore
  files rather than letting the library read their targets.
- The walker gives `.ignore` precedence over `.gitignore` across directory depth;
  within each ignore-file type, a deeper file has precedence over a parent file.
  HorizonCode records cross-depth and negation regression cases.
- HorizonCode bounds each local rule file at 1 MiB and the total rule contents
  checked for one search at 16 MiB. It caps entries delivered to `filter_entry`
  at 100,000 and aggregate `grep` input at 64 MiB. The entry cap does not count
  entries the library filters internally before invoking the callback, so it is
  not a full traversal-work bound.

These guarantees still have normal filesystem race limits: the walker later
reopens ignore files by path, and directory traversal is not a handle-relative
no-follow API. The architecture makes no claim that these checks remove all
concurrent filesystem mutation windows. Cancellation is checked before walker
advances, in delivered-entry callbacks, and at line-yield boundaries. The walker
can internally filter ignored entries before invoking the callback, so an
unbounded internal skip run can delay cancellation; a bounded synchronous file
read can delay it as well. The filter cap does not bound those internal entries,
so wide-directory traversal work and cancellation latency remain open.

## Local verification status

The dependency review is not local runtime evidence. `ACC-TOOL-SEARCH-01` remains
pending until its complete test/evidence bundle is recorded against an integrated
revision and named platform.
