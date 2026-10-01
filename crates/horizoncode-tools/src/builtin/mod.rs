//! First-party built-in tools.
//!
//! Every tool resolves paths inside the active workspace (refusing escapes),
//! declares a typed input schema, and never panics on hostile input. Mutating
//! and exec tools re-assert the guard immediately before the effect, so a tool
//! invoked directly cannot bypass policy (`ARCH/core/TOOLS.md`).

mod bash;
mod edit;
mod glob;
mod grep;
mod list;
mod patch;
mod question;
mod read;
mod todo;
mod write;

pub use bash::BashTool;
pub use edit::EditTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use list::ListTool;
pub use patch::ApplyPatchTool;
pub use question::{QuestionHandler, QuestionTool};
pub use read::ReadTool;
pub use todo::{TodoItem, TodoStatus, TodoStore, TodoTool};
pub use write::WriteTool;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use horizoncode_sandbox::FsOp;
use ignore::{DirEntry, Walk, WalkBuilder};
use serde_json::{Value, json};

use crate::error::ToolError;
use crate::policy::{GateDecision, PermissionRequest};
use crate::registry::ToolContext;
use horizoncode_types::CancelToken;

const MAX_IGNORE_FILE_BYTES: u64 = 1_048_576;
const MAX_SEARCH_IGNORE_BYTES: u64 = 16_777_216;
pub(crate) const MAX_SEARCH_ENTRIES: u64 = 100_000;

/// Builds an object JSON schema.
pub(crate) fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Reads a required string field.
pub(crate) fn require_str(input: &Value, key: &str) -> Result<String, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolError::InvalidInput(format!("`{key}` must be a non-empty string")))
}

/// Reads an optional string field.
pub(crate) fn optional_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

/// Reads an optional boolean field.
pub(crate) fn optional_bool(input: &Value, key: &str) -> Result<bool, ToolError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| ToolError::InvalidInput(format!("`{key}` must be a boolean"))),
    }
}

/// Reads an optional non-negative integer field.
pub(crate) fn optional_usize(input: &Value, key: &str) -> Result<Option<usize>, ToolError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(|value| Some(value as usize))
            .ok_or_else(|| {
                ToolError::InvalidInput(format!("`{key}` must be a non-negative integer"))
            }),
    }
}

/// Returns whether a byte slice is likely binary (contains a NUL byte).
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

/// Renders a path relative to the workspace when possible.
pub(crate) fn display_path(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Sorts directory entries with directories first, then by name.
pub(crate) fn sort_entries(entries: &mut [std::fs::DirEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });
}

/// Re-asserts the guard for a tool immediately before its effect.
///
/// This is the **spend** of the one authorization the registry already decided,
/// not a second decision: on a gate that issues tickets the effect runs against a
/// grant that was checked for scope, expiry, uses, and policy fingerprint rather
/// than against a remembered decision. It carries the same
/// `(action, resources, targets)` shape the registry used, so a request that grew
/// after authorization cannot pass on a narrower grant, and the turn is carried
/// too, so the spend lands on the grant this call actually holds.
pub(crate) async fn assert_action(
    ctx: &ToolContext,
    action: &str,
    resources: Vec<String>,
    targets: Vec<crate::policy::PermissionTarget>,
) -> Result<(), ToolError> {
    let Some(gate) = &ctx.gate else {
        return Ok(());
    };
    let request = PermissionRequest {
        action: action.to_owned(),
        tool_name: action.to_owned(),
        resources,
        session_id: ctx.session_id.clone(),
        source: ctx.tool_call_id.clone(),
        turn_id: ctx.turn_id.clone(),
        metadata: json!({ "self_assert": true }),
        targets,
    };
    match gate.consume(&request).await {
        GateDecision::Allow => Ok(()),
        GateDecision::Deny { reason } => Err(ToolError::Denied(reason)),
    }
}

/// Consults the confinement layer for an in-process filesystem operation.
///
/// This is the tool plane's only reach check, and it is **fail-closed**: when no
/// resolved plan is in force there is no enforcement at all — no deny glob, no
/// protected subpath, no root scope — so the operation is refused rather than
/// performed unenforced (`ARCH/13` §Failure modes, `REQ-SEC-010`). A tool that
/// treated "no plan" as "no restriction" would let a `write` install a hook or a
/// `read` return a deny-globbed secret on any host whose backend failed to
/// probe.
///
/// The plan alone is enough: an in-process path operation is scoped by
/// [`horizoncode_sandbox::check_path`], and the spawn backend is only needed to *run*
/// something. That is also why the single shared implementation is called
/// directly instead of through a provider, so the tool plane and every tier reach
/// the same policy rather than a second copy of it.
pub(crate) fn check_reach(ctx: &ToolContext, op: FsOp, path: &Path) -> Result<(), ToolError> {
    let Some(resolved) = ctx.resolved.as_deref() else {
        return Err(ToolError::Denied(format!(
            "no confinement profile is resolved, so the reach of {} cannot be bounded; \
             refusing the operation rather than performing it unenforced",
            path.display()
        )));
    };
    horizoncode_sandbox::check_path(op, path, resolved).map_err(|error| {
        ToolError::Denied(format!(
            "confinement refused {} of {}: {error}",
            match op {
                FsOp::Read => "read",
                FsOp::Write => "write",
            },
            path.display()
        ))
    })
}

/// Consults the confinement layer for an in-process write.
pub(crate) fn check_sandbox_write(ctx: &ToolContext, path: &Path) -> Result<(), ToolError> {
    check_reach(ctx, FsOp::Write, path)
}

/// Consults the confinement layer for an in-process read.
pub(crate) fn check_sandbox_read(ctx: &ToolContext, path: &Path) -> Result<(), ToolError> {
    check_reach(ctx, FsOp::Read, path)
}

/// A recursive read-only workspace walk with explicit ignore and confinement
/// semantics. The ignore crate reads ignore files internally, so each
/// traversed directory checks the candidate files before allowing descent.
pub(crate) struct ReadOnlyWalker {
    inner: Option<Walk>,
    state: Arc<Mutex<WalkState>>,
    fallback: PathBuf,
    cancel: CancelToken,
}

#[derive(Default)]
struct WalkState {
    error: Option<ToolError>,
    visited_entries: u64,
    ignore_bytes: u64,
}

impl Iterator for ReadOnlyWalker {
    type Item = Result<DirEntry, ToolError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.cancel.is_cancelled() {
            self.inner = None;
            return Some(Err(ToolError::Aborted(
                "recursive search cancelled".to_owned(),
            )));
        }
        let next = self.inner.as_mut()?.next();
        let filter_error = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .error
            .take();
        if let Some(error) = filter_error {
            self.inner = None;
            return Some(Err(error));
        }
        match next {
            Some(Ok(entry)) => {
                if let Some(error) = entry.error() {
                    self.inner = None;
                    Some(Err(ToolError::Io {
                        path: entry.path().to_path_buf(),
                        message: error.to_string(),
                    }))
                } else {
                    Some(Ok(entry))
                }
            }
            Some(Err(error)) => {
                self.inner = None;
                Some(Err(ToolError::Io {
                    path: self.fallback.clone(),
                    message: error.to_string(),
                }))
            }
            None => None,
        }
    }
}

/// Creates a confined walk using only `.ignore` and `.gitignore` files below
/// the selected root. Hidden files remain visible, parent/global Git excludes
/// are disabled, symlinks are not followed, and `.git` directories are pruned.
pub(crate) fn read_only_walk(ctx: &ToolContext, base: &Path) -> Result<ReadOnlyWalker, ToolError> {
    read_only_walk_with_entry_limit(ctx, base, MAX_SEARCH_ENTRIES)
}

fn read_only_walk_with_entry_limit(
    ctx: &ToolContext,
    base: &Path,
    entry_limit: u64,
) -> Result<ReadOnlyWalker, ToolError> {
    check_sandbox_read(ctx, base)?;

    // A selected root inside Git metadata is itself excluded. Returning an
    // empty iterator also avoids interpreting ignore files inside `.git`.
    if base
        .strip_prefix(&ctx.workspace)
        .unwrap_or(base)
        .components()
        .any(|component| component.as_os_str() == ".git")
    {
        return Ok(ReadOnlyWalker {
            inner: None,
            state: Arc::new(Mutex::new(WalkState::default())),
            fallback: base.to_path_buf(),
            cancel: ctx.cancel.clone(),
        });
    }

    let state = Arc::new(Mutex::new(WalkState::default()));
    {
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        check_local_ignore_files(ctx, base, &mut state.ignore_bytes)?;
    }
    let stored_state = Arc::clone(&state);
    let context = ctx.clone();
    let root = base.to_path_buf();
    let walker = WalkBuilder::new(base)
        .standard_filters(false)
        .hidden(false)
        .parents(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        // A selected root may be below the repository's .git marker. Local
        // .gitignore files are still part of the selected-root contract.
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            let mut state = stored_state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.error.is_some() {
                return false;
            }
            if context.cancel.is_cancelled() {
                state.error = Some(ToolError::Aborted("recursive search cancelled".to_owned()));
                return false;
            }
            state.visited_entries = state.visited_entries.saturating_add(1);
            if state.visited_entries > entry_limit {
                state.error = Some(ToolError::SearchLimit {
                    resource: "traversed entries".to_owned(),
                    limit: entry_limit,
                    observed: state.visited_entries,
                });
                return false;
            }
            if entry.path() != root && entry.file_name() == ".git" {
                return false;
            }
            let Some(file_type) = entry.file_type() else {
                state.error = Some(ToolError::Io {
                    path: entry.path().to_path_buf(),
                    message: "could not determine entry type during traversal".to_owned(),
                });
                return false;
            };
            if file_type.is_dir() {
                if let Err(error) = check_sandbox_read(&context, entry.path()) {
                    state.error = Some(error);
                    return false;
                }
                if let Err(error) =
                    check_local_ignore_files(&context, entry.path(), &mut state.ignore_bytes)
                {
                    state.error = Some(error);
                    return false;
                }
            }
            true
        })
        .build();

    Ok(ReadOnlyWalker {
        inner: Some(walker),
        state,
        fallback: base.to_path_buf(),
        cancel: ctx.cancel.clone(),
    })
}

/// Checks ignore-file reach before the walker library reads those files.
fn check_local_ignore_files(
    ctx: &ToolContext,
    directory: &Path,
    aggregate_bytes: &mut u64,
) -> Result<(), ToolError> {
    check_local_ignore_files_with_limit(ctx, directory, aggregate_bytes, MAX_SEARCH_IGNORE_BYTES)
}

fn check_local_ignore_files_with_limit(
    ctx: &ToolContext,
    directory: &Path,
    aggregate_bytes: &mut u64,
    aggregate_limit: u64,
) -> Result<(), ToolError> {
    if ctx.cancel.is_cancelled() {
        return Err(ToolError::Aborted("recursive search cancelled".to_owned()));
    }
    for name in [".ignore", ".gitignore"] {
        let path = directory.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(ToolError::UnsupportedTarget(path.display().to_string()));
                }
                if !metadata.is_file() {
                    return Err(ToolError::UnsupportedTarget(path.display().to_string()));
                }
                check_sandbox_read(ctx, &path)?;
                let mut file = std::fs::File::open(&path).map_err(|error| ToolError::Io {
                    path: path.clone(),
                    message: error.to_string(),
                })?;
                let opened = file.metadata().map_err(|error| ToolError::Io {
                    path: path.clone(),
                    message: error.to_string(),
                })?;
                if !opened.is_file() {
                    return Err(ToolError::UnsupportedTarget(path.display().to_string()));
                }
                if opened.len() > MAX_IGNORE_FILE_BYTES {
                    return Err(ToolError::OutputLimit {
                        resource: path.display().to_string(),
                        limit_bytes: MAX_IGNORE_FILE_BYTES,
                        observed_bytes: opened.len(),
                    });
                }
                let remaining = aggregate_limit.saturating_sub(*aggregate_bytes);
                if opened.len() > remaining {
                    return Err(ToolError::SearchLimit {
                        resource: "aggregate ignore-file bytes".to_owned(),
                        limit: aggregate_limit,
                        observed: aggregate_bytes.saturating_add(opened.len()),
                    });
                }
                let mut contents = Vec::new();
                (&mut file)
                    .take(remaining.min(MAX_IGNORE_FILE_BYTES) + 1)
                    .read_to_end(&mut contents)
                    .map_err(|error| ToolError::Io {
                        path: path.clone(),
                        message: error.to_string(),
                    })?;
                if contents.len() as u64 > MAX_IGNORE_FILE_BYTES {
                    return Err(ToolError::OutputLimit {
                        resource: path.display().to_string(),
                        limit_bytes: MAX_IGNORE_FILE_BYTES,
                        observed_bytes: contents.len() as u64,
                    });
                }
                if contents.len() as u64 > remaining {
                    return Err(ToolError::SearchLimit {
                        resource: "aggregate ignore-file bytes".to_owned(),
                        limit: aggregate_limit,
                        observed: aggregate_bytes.saturating_add(contents.len() as u64),
                    });
                }
                *aggregate_bytes = aggregate_bytes.saturating_add(contents.len() as u64);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => {
                return Err(ToolError::Io {
                    path,
                    message: error.to_string(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
    use horizoncode_types::{SessionId, ToolCallId};

    fn scope(dir: &Path) -> ResolvedProfile {
        let profile = ConfinementProfile::workspace_write(dir);
        ResolvedProfile {
            backend: "test".to_owned(),
            profile: profile.profile,
            network: profile.network.clone(),
            workspace: profile.workspace.clone(),
            writable_roots: profile.writable_roots(),
            readable_roots: profile.readable_roots(),
            protected: profile.protected.clone(),
            deny: profile.deny.clone(),
            session_dir: profile.session_dir.clone(),
            limits: profile.limits,
            applied: Vec::new(),
            epoch: 1,
            bare: false,
        }
    }

    #[test]
    fn traversal_entry_limit_stops_before_returning_partial_success() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let ctx = ToolContext::new(SessionId::new("s"), ToolCallId::new("c"), dir.path())
            .with_resolved_scope(scope(dir.path()));

        let result = read_only_walk_with_entry_limit(&ctx, dir.path(), 1)
            .unwrap()
            .collect::<Result<Vec<_>, _>>();
        assert!(matches!(
            result,
            Err(ToolError::SearchLimit {
                resource,
                limit: 1,
                observed: 2
            }) if resource == "traversed entries"
        ));
    }

    #[test]
    fn traversal_observes_cancellation_between_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let ctx = ToolContext::new(SessionId::new("s"), ToolCallId::new("c"), dir.path())
            .with_resolved_scope(scope(dir.path()));
        let mut walker = read_only_walk_with_entry_limit(&ctx, dir.path(), 10).unwrap();
        assert!(walker.next().unwrap().is_ok());
        ctx.cancel.cancel();
        assert!(matches!(
            walker.next(),
            Some(Err(ToolError::Aborted(message))) if message.contains("cancelled")
        ));
    }

    #[test]
    fn aggregate_ignore_file_limit_counts_all_local_rules() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".ignore"), "aa").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "bb").unwrap();
        let ctx = ToolContext::new(SessionId::new("s"), ToolCallId::new("c"), dir.path())
            .with_resolved_scope(scope(dir.path()));
        let mut aggregate = 0;
        check_local_ignore_files_with_limit(&ctx, dir.path(), &mut aggregate, 4).unwrap();
        assert_eq!(aggregate, 4);

        std::fs::write(dir.path().join(".gitignore"), "bbb").unwrap();
        let mut aggregate = 0;
        let result = check_local_ignore_files_with_limit(&ctx, dir.path(), &mut aggregate, 4);
        assert!(matches!(
            result,
            Err(ToolError::SearchLimit {
                resource,
                limit: 4,
                observed: 5
            }) if resource == "aggregate ignore-file bytes"
        ));
    }
}
