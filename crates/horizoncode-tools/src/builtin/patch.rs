//! The `apply_patch` tool: validate the complete patch, stage its final file
//! states, then publish each changed file with a per-file replacement.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use horizoncode_types::{ContentPart, ToolDefinition};
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_read, check_sandbox_write, display_path, object_schema,
    require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};
use crate::write::file_digest;

const MAX_PATCH_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATCH_LINES: usize = 131_072;
const MAX_PATCH_TARGET_LINES: usize = 1_000_000;
const MAX_PATCH_OPERATIONS: usize = 256;
const MAX_PATCH_HUNKS: usize = 4_096;
const MAX_PATCH_FILE_BYTES: u64 = 16_777_216;
const MAX_PATCH_BASE_BYTES: u64 = 67_108_864;
const MAX_PATCH_TRANSFORM_WORK_BYTES: u64 = 134_217_728;

/// A parsed file operation.
#[derive(Clone, Debug)]
enum Op {
    Add { path: String, content: String },
    Update { path: String, hunks: Vec<Hunk> },
    Delete { path: String },
}

impl Op {
    fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Update { path, .. } | Self::Delete { path } => path,
        }
    }
}

/// One contiguous update hunk.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Hunk {
    old: Vec<String>,
    new: Vec<String>,
}

/// A target's captured and simulated state. Repeated operations on one path
/// are simulated in order and result in one final publication for that path.
#[derive(Debug)]
struct PreparedTarget {
    path: PathBuf,
    raw_paths: Vec<String>,
    display: String,
    base: Option<Vec<u8>>,
    desired: Option<Vec<u8>>,
    permissions: Option<fs::Permissions>,
    staged: Option<StagedFile>,
}

impl PreparedTarget {
    fn changed(&self) -> bool {
        self.base != self.desired
    }

    fn receipt(&self) -> String {
        match (&self.base, &self.desired) {
            (None, Some(bytes)) => format!("A {} {}", self.display, file_digest(bytes)),
            (Some(_), Some(bytes)) => format!("M {} {}", self.display, file_digest(bytes)),
            (Some(_), None) => format!("D {} removed", self.display),
            (None, None) => format!("- {} unchanged", self.display),
        }
    }
}

/// Removes an unpublished same-directory staging file on every return path.
#[derive(Debug)]
struct StagedFile(PathBuf);

impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PatchBoundary {
    Stage,
    Publish,
}

/// Applies a structured patch to workspace files.
#[derive(Debug, Default)]
pub struct ApplyPatchTool;

#[async_trait]
impl Tool for ApplyPatchTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "apply_patch",
            "Apply a structured patch with `*** Add File:`, `*** Update File:` \
             (with `@@` hunks) and `*** Delete File:` sections, wrapped in \
             `*** Begin Patch`/`*** End Patch`. Update hunks must match uniquely. \
             Limits: 4 MiB patch text, 256 operations, 16 MiB per base file, \
             and 64 MiB combined base data.",
            object_schema(
                json!({
                    "patchText": {
                        "type": "string",
                        "description": "The patch body."
                    }
                }),
                &["patchText"],
            ),
            None,
        )
    }

    fn action(&self) -> String {
        "edit".to_owned()
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let patch = require_str(&input, "patchText")?;
        execute_patch(&patch, ctx, |_, _, _| Ok(())).await
    }
}

async fn execute_patch<F>(
    patch: &str,
    ctx: &ToolContext,
    mut inject: F,
) -> Result<ToolOutput, ToolError>
where
    F: FnMut(PatchBoundary, usize, &Path) -> io::Result<()>,
{
    if patch.len() > MAX_PATCH_TEXT_BYTES {
        return Err(ToolError::PatchLimit {
            resource: "patch text".to_owned(),
            limit_bytes: MAX_PATCH_TEXT_BYTES as u64,
            observed_bytes: patch.len() as u64,
        });
    }
    let ops = parse_patch(patch)?;
    let mut resolved_ops = Vec::with_capacity(ops.len());
    for op in &ops {
        let resolved = resolve_workspace_path(&ctx.workspace, op.path())?;
        resolved_ops.push((op.clone(), resolved));
    }

    // Preserve the established ordering: resolve and authorize the complete
    // target set before reading file contents, then check every target against
    // the active confinement profile before opening any target.
    let resources: Vec<String> = ops.iter().map(|op| op.path().to_owned()).collect();
    let extra = crate::registry::additional_targets_from_input(&json!({"patchText": patch}));
    assert_action(ctx, "edit", resources, extra).await?;

    for (op, original) in &resolved_ops {
        check_cancelled(ctx)?;
        check_sandbox_write(ctx, original)?;
        check_sandbox_read(ctx, original)?;
        let current = resolve_workspace_path(&ctx.workspace, op.path())?;
        if current != *original {
            return Err(conflict(
                original,
                "the target resolved to a different path after approval",
            ));
        }
    }

    let mut targets = Vec::<PreparedTarget>::new();
    let mut target_indices = BTreeMap::<PathBuf, usize>::new();
    let mut captured_base_bytes = 0u64;
    let mut patch_match_work_bytes = 0u64;
    for (op, path) in &resolved_ops {
        let index = if let Some(index) = target_indices.get(path) {
            *index
        } else {
            check_sandbox_read(ctx, path)?;
            let remaining = MAX_PATCH_BASE_BYTES.saturating_sub(captured_base_bytes);
            let per_file_limit = MAX_PATCH_FILE_BYTES.min(remaining);
            let (base, permissions) = snapshot(path, per_file_limit)?;
            captured_base_bytes = captured_base_bytes
                .saturating_add(base.as_ref().map_or(0, |bytes| bytes.len() as u64));
            let index = targets.len();
            targets.push(PreparedTarget {
                path: path.clone(),
                raw_paths: Vec::new(),
                display: display_path(&ctx.workspace, path),
                base: base.clone(),
                desired: base,
                permissions,
                staged: None,
            });
            target_indices.insert(path.clone(), index);
            index
        };
        let target = &mut targets[index];
        if !target.raw_paths.iter().any(|raw| raw == op.path()) {
            target.raw_paths.push(op.path().to_owned());
        }
        match op {
            Op::Add { content, .. } => {
                target.desired = Some(content.as_bytes().to_vec());
            }
            Op::Update { path, hunks } => {
                let Some(bytes) = target.desired.as_ref() else {
                    return Err(ToolError::NotFound(target.display.clone()));
                };
                let text = std::str::from_utf8(bytes)
                    .map_err(|_| ToolError::InvalidInput(format!("`{path}` is not valid UTF-8")))?;
                target.desired = Some(
                    apply_hunks(text, hunks, path, &mut patch_match_work_bytes)?.into_bytes(),
                );
            }
            Op::Delete { .. } => {
                if target.desired.is_none() {
                    return Err(ToolError::NotFound(target.display.clone()));
                }
                target.desired = None;
            }
        }
    }

    let summaries: Vec<String> = resolved_ops
        .iter()
        .map(|(op, path)| {
            let step = match op {
                Op::Add { .. } => {
                    if targets[target_indices[path]].base.is_some() {
                        'M'
                    } else {
                        'A'
                    }
                }
                Op::Update { .. } => 'M',
                Op::Delete { .. } => 'D',
            };
            format!("{step} {}", display_path(&ctx.workspace, path))
        })
        .collect();

    let mut created_dirs = Vec::new();
    let result = stage_and_publish(&mut targets, ctx, &mut inject, &mut created_dirs);
    if result.is_err() {
        for target in &mut targets {
            target.staged.take();
        }
        cleanup_created_dirs(&mut created_dirs);
    }
    let receipts = result?;

    Ok(ToolOutput {
        model_content: vec![ContentPart::text(summaries.join("\n"))],
        structured: Some(json!({ "operations": summaries, "fileReceipts": receipts })),
        ui_detail: Some(json!({ "fileReceipts": receipts })),
    })
}

fn stage_and_publish<F>(
    targets: &mut [PreparedTarget],
    ctx: &ToolContext,
    inject: &mut F,
    created_dirs: &mut Vec<PathBuf>,
) -> Result<Vec<String>, ToolError>
where
    F: FnMut(PatchBoundary, usize, &Path) -> io::Result<()>,
{
    for target in targets.iter().filter(|target| target.changed()) {
        validate_target(target, ctx)?;
    }

    // Stage every replacement before the first target file is published.
    for (index, target) in targets.iter_mut().enumerate() {
        let Some(bytes) = target.desired.as_ref().filter(|_| target.changed()) else {
            continue;
        };
        if target
            .permissions
            .as_ref()
            .is_some_and(fs::Permissions::readonly)
        {
            return Err(ToolError::Denied(format!(
                "patch target `{}` is read-only",
                target.display
            )));
        }
        check_cancelled(ctx)?;
        ensure_parent_dirs(&target.path, created_dirs)?;
        validate_target(target, ctx)?;
        inject(PatchBoundary::Stage, index, &target.path)
            .map_err(|error| io_error(&target.path, error))?;
        let staged = stage_file(&target.path, bytes, target.permissions.as_ref(), ctx)?;
        target.staged = Some(staged);
    }

    // A stage hook, concurrent editor, or external process may have changed a
    // base. Recheck every base before the first publication.
    for target in targets.iter().filter(|target| target.changed()) {
        validate_target(target, ctx)?;
    }

    let mut committed = Vec::<String>::new();
    let changed: Vec<usize> = targets
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target.changed().then_some(index))
        .collect();

    for (position, index) in changed.iter().copied().enumerate() {
        let (publish_result, receipt, failed_display) = {
            let target = &mut targets[index];
            let publish_result = (|| {
                check_cancelled(ctx)?;
                validate_target(target, ctx)?;
                inject(PatchBoundary::Publish, position, &target.path)
                    .map_err(|error| io_error(&target.path, error))?;
                validate_target(target, ctx)?;
                match target.desired.as_ref() {
                    Some(_) => {
                        let staged = target.staged.as_ref().ok_or_else(|| {
                            ToolError::Execute(
                                "validated patch file has no staged content".to_owned(),
                            )
                        })?;
                        fs::rename(&staged.0, &target.path)
                            .map_err(|error| io_error(&target.path, error))?;
                        target.staged = None;
                    }
                    None => {
                        fs::remove_file(&target.path)
                            .map_err(|error| io_error(&target.path, error))?;
                    }
                }
                Ok::<(), ToolError>(())
            })();
            (publish_result, target.receipt(), target.display.clone())
        };

        if let Err(error) = publish_result {
            if committed.is_empty() {
                return Err(error);
            }
            let pending = changed[position..]
                .iter()
                .map(|pending_index| targets[*pending_index].display.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ToolError::PartialEffect {
                committed: committed.join("; "),
                pending,
                failed: failed_display,
                cause: error.model_message(),
            });
        }
        committed.push(receipt);
    }

    Ok(committed)
}

fn validate_target(target: &PreparedTarget, ctx: &ToolContext) -> Result<(), ToolError> {
    check_cancelled(ctx)?;
    for raw in &target.raw_paths {
        let resolved = resolve_workspace_path(&ctx.workspace, raw)?;
        if resolved != target.path {
            return Err(conflict(
                &target.path,
                "the target resolved to a different path after approval",
            ));
        }
    }
    check_sandbox_write(ctx, &target.path)?;
    check_sandbox_read(ctx, &target.path)?;
    let (current, _) = snapshot(&target.path, MAX_PATCH_FILE_BYTES)?;
    if current != target.base {
        return Err(base_conflict(
            &target.path,
            target.base.as_deref(),
            current.as_deref(),
        ));
    }
    Ok(())
}

fn snapshot(
    path: &Path,
    limit_bytes: u64,
) -> Result<(Option<Vec<u8>>, Option<fs::Permissions>), ToolError> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((None, None)),
        Err(error) => return Err(io_error(path, error)),
    };
    if !path_metadata.file_type().is_file() {
        return Err(ToolError::UnsupportedTarget(path.display().to_string()));
    }
    let file = File::open(path).map_err(|error| io_error(path, error))?;
    let metadata = file.metadata().map_err(|error| io_error(path, error))?;
    if !metadata.file_type().is_file() {
        return Err(ToolError::UnsupportedTarget(path.display().to_string()));
    }
    if metadata.len() > limit_bytes {
        return Err(ToolError::PatchLimit {
            resource: path.display().to_string(),
            limit_bytes,
            observed_bytes: metadata.len(),
        });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    if bytes.len() as u64 > limit_bytes {
        return Err(ToolError::PatchLimit {
            resource: path.display().to_string(),
            limit_bytes,
            observed_bytes: bytes.len() as u64,
        });
    }
    Ok((Some(bytes), Some(metadata.permissions())))
}

static STAGE_ID: AtomicU64 = AtomicU64::new(1);

fn stage_file(
    target: &Path,
    bytes: &[u8],
    permissions: Option<&fs::Permissions>,
    ctx: &ToolContext,
) -> Result<StagedFile, ToolError> {
    let parent = target.parent().ok_or_else(|| {
        ToolError::InvalidInput(format!(
            "target `{}` has no parent directory",
            target.display()
        ))
    })?;
    for _ in 0..32 {
        let id = STAGE_ID.fetch_add(1, Ordering::Relaxed);
        let staged = parent.join(format!(
            ".horizoncode-patch-{}-{id}.tmp",
            std::process::id()
        ));
        check_sandbox_write(ctx, &staged)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&staged) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(&staged, error)),
        };
        let result = (|| {
            let default_permissions = file.metadata()?.permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(bytes)?;
            file.set_permissions(permissions.cloned().unwrap_or(default_permissions))?;
            file.sync_all()
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&staged);
            return Err(io_error(&staged, error));
        }
        return Ok(StagedFile(staged));
    }
    Err(ToolError::Execute(
        "could not allocate a unique patch staging file".to_owned(),
    ))
}

fn ensure_parent_dirs(target: &Path, created: &mut Vec<PathBuf>) -> Result<(), ToolError> {
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    let mut missing = Vec::new();
    let mut cursor = parent;
    loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => return Err(ToolError::UnsupportedTarget(cursor.display().to_string())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor.parent().ok_or_else(|| io_error(cursor, error))?;
            }
            Err(error) => return Err(io_error(cursor, error)),
        }
    }
    for directory in missing.into_iter().rev() {
        match fs::create_dir(&directory) {
            Ok(()) => created.push(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&directory)
                    .map_err(|error| io_error(&directory, error))?;
                if !metadata.is_dir() {
                    return Err(ToolError::UnsupportedTarget(
                        directory.display().to_string(),
                    ));
                }
            }
            Err(error) => return Err(io_error(&directory, error)),
        }
    }
    Ok(())
}

fn cleanup_created_dirs(created: &mut Vec<PathBuf>) {
    created.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in created.drain(..) {
        let _ = fs::remove_dir(directory);
    }
}

fn check_cancelled(ctx: &ToolContext) -> Result<(), ToolError> {
    if ctx.cancel.is_cancelled() {
        return Err(ToolError::Aborted("patch application cancelled".to_owned()));
    }
    Ok(())
}

fn io_error(path: &Path, error: io::Error) -> ToolError {
    ToolError::Io {
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

fn conflict(path: &Path, message: &str) -> ToolError {
    ToolError::Conflict {
        path: path.to_string_lossy().into_owned(),
        message: message.to_owned(),
    }
}

fn base_conflict(path: &Path, base: Option<&[u8]>, current: Option<&[u8]>) -> ToolError {
    let base_digest = base
        .map(file_digest)
        .unwrap_or_else(|| "<missing>".to_owned());
    let current_digest = current
        .map(file_digest)
        .unwrap_or_else(|| "<missing>".to_owned());
    conflict(
        path,
        &format!("base changed before publication (base {base_digest}, current {current_digest})"),
    )
}

fn parse_patch(text: &str) -> Result<Vec<Op>, ToolError> {
    let line_count = text.lines().take(MAX_PATCH_LINES + 1).count();
    if line_count > MAX_PATCH_LINES {
        return Err(ToolError::PatchCountLimit {
            resource: "patch lines".to_owned(),
            limit: MAX_PATCH_LINES as u64,
            observed: line_count as u64,
        });
    }
    let hunk_count = text
        .lines()
        .filter(|line| line.trim_start().starts_with("@@"))
        .take(MAX_PATCH_HUNKS + 1)
        .count();
    if hunk_count > MAX_PATCH_HUNKS {
        return Err(ToolError::PatchCountLimit {
            resource: "patch hunks".to_owned(),
            limit: MAX_PATCH_HUNKS as u64,
            observed: hunk_count as u64,
        });
    }
    let operation_count = text
        .lines()
        .filter(|line| {
            let line = line.trim_end();
            line.starts_with("*** Add File:")
                || line.starts_with("*** Update File:")
                || line.starts_with("*** Delete File:")
        })
        .take(MAX_PATCH_OPERATIONS + 1)
        .count();
    if operation_count > MAX_PATCH_OPERATIONS {
        return Err(ToolError::PatchCountLimit {
            resource: "patch operations".to_owned(),
            limit: MAX_PATCH_OPERATIONS as u64,
            observed: operation_count as u64,
        });
    }
    let mut ops = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim_end();
        index += 1;
        if line.is_empty()
            || line.starts_with("*** Begin Patch")
            || line.starts_with("*** End Patch")
        {
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File:") {
            let mut content = String::new();
            while index < lines.len() && !lines[index].trim_end().starts_with("*** ") {
                let body = lines[index]
                    .strip_prefix('+')
                    .ok_or_else(|| invalid("add-file lines must start with `+`"))?;
                content.push_str(body);
                content.push('\n');
                index += 1;
            }
            ops.push(Op::Add {
                path: path.trim().to_owned(),
                content,
            });
        } else if let Some(path) = line.strip_prefix("*** Delete File:") {
            ops.push(Op::Delete {
                path: path.trim().to_owned(),
            });
        } else if let Some(path) = line.strip_prefix("*** Update File:") {
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].trim_end().starts_with("*** ") {
                body.push(lines[index].to_owned());
                index += 1;
            }
            ops.push(Op::Update {
                path: path.trim().to_owned(),
                hunks: parse_hunks(&body)?,
            });
        } else {
            return Err(invalid(format!("unexpected patch line `{line}`")));
        }
    }
    if ops.is_empty() {
        return Err(invalid("patch contains no file operations"));
    }
    if ops.len() > MAX_PATCH_OPERATIONS {
        return Err(invalid(format!(
            "patch contains {} operations; the maximum is {MAX_PATCH_OPERATIONS}",
            ops.len()
        )));
    }
    Ok(ops)
}

fn parse_hunks(body: &[String]) -> Result<Vec<Hunk>, ToolError> {
    let mut hunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in body {
        if line.trim_start().starts_with("@@") {
            if !current.is_empty() {
                hunks.push(build_hunk(&current)?);
                current.clear();
            }
            continue;
        }
        current.push(line.clone());
    }
    if !current.is_empty() {
        hunks.push(build_hunk(&current)?);
    }
    if hunks.is_empty() {
        return Err(invalid("update hunk is empty"));
    }
    Ok(hunks)
}

fn build_hunk(lines: &[String]) -> Result<Hunk, ToolError> {
    let mut old = Vec::new();
    let mut new = Vec::new();
    for line in lines {
        if let Some(rest) = line.strip_prefix(' ') {
            old.push(rest.to_owned());
            new.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('-') {
            old.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('+') {
            new.push(rest.to_owned());
        } else if line.is_empty() {
            old.push(String::new());
            new.push(String::new());
        } else {
            return Err(invalid(format!("invalid hunk line `{line}`")));
        }
    }
    if old == new {
        return Err(invalid("hunk contains no changes"));
    }
    Ok(Hunk { old, new })
}

fn apply_hunks(
    text: &str,
    hunks: &[Hunk],
    path: &str,
    work_bytes: &mut u64,
) -> Result<String, ToolError> {
    *work_bytes = work_bytes.saturating_add(text.len() as u64);
    if *work_bytes > MAX_PATCH_TRANSFORM_WORK_BYTES {
        return Err(ToolError::PatchLimit {
            resource: "patch transformation work".to_owned(),
            limit_bytes: MAX_PATCH_TRANSFORM_WORK_BYTES,
            observed_bytes: *work_bytes,
        });
    }
    let trailing_newline = text.ends_with('\n');
    let line_count = text.lines().take(MAX_PATCH_TARGET_LINES + 1).count();
    if line_count > MAX_PATCH_TARGET_LINES {
        return Err(ToolError::PatchCountLimit {
            resource: "patch target lines".to_owned(),
            limit: MAX_PATCH_TARGET_LINES as u64,
            observed: line_count as u64,
        });
    }
    let mut lines: Vec<&str> = text.lines().collect();
    for hunk in hunks {
        if hunk.old.is_empty() {
            return Err(invalid("cannot apply an empty hunk"));
        }
        if hunk.old.len() > lines.len() {
            return Err(invalid(format!("hunk did not match `{path}`")));
        }
        let mut found: Option<usize> = None;
        let mut count = 0usize;
        let limit = lines.len().saturating_sub(hunk.old.len());
        for start in 0..=limit {
            let mut matches = true;
            for (actual, expected) in lines[start..start + hunk.old.len()].iter().zip(&hunk.old) {
                *work_bytes = work_bytes.saturating_add(actual.len().max(expected.len()) as u64);
                if *work_bytes > MAX_PATCH_TRANSFORM_WORK_BYTES {
                    return Err(ToolError::PatchLimit {
                        resource: "patch hunk comparison work".to_owned(),
                        limit_bytes: MAX_PATCH_TRANSFORM_WORK_BYTES,
                        observed_bytes: *work_bytes,
                    });
                }
                if actual != expected {
                    matches = false;
                    break;
                }
            }
            if matches {
                count += 1;
                found = Some(start);
            }
        }
        match (count, found) {
            (0, _) => return Err(invalid(format!("hunk did not match `{path}`"))),
            (1, Some(start)) => {
                lines.splice(
                    start..start + hunk.old.len(),
                    hunk.new.iter().map(String::as_str),
                );
            }
            _ => {
                return Err(invalid(format!(
                    "hunk matched {count} locations in `{path}`; add more context"
                )));
            }
        }
    }
    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::InvalidInput(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use horizoncode_sandbox::{ConfinementProfile, ResolvedProfile};
    use horizoncode_types::{SessionId, ToolCallId};

    fn context(root: &Path) -> ToolContext {
        let profile = ConfinementProfile::workspace_write(root);
        let resolved = ResolvedProfile {
            backend: "patch-test".to_owned(),
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
        };
        ToolContext::new(
            SessionId::new("ses_patch"),
            ToolCallId::new("call_patch"),
            root,
        )
        .with_resolved_scope(resolved)
    }

    #[tokio::test]
    async fn late_hunk_failure_does_not_publish_earlier_file_add() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("existing.txt"), "base\n").unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Add File: new.txt\n",
            "+new content\n",
            "*** Update File: existing.txt\n",
            "@@\n",
            "-missing\n",
            "+replacement\n",
            "*** End Patch\n",
        );

        let error = execute_patch(patch, &context(dir.path()), |_, _, _| Ok(()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("did not match"));
        assert!(!dir.path().join("new.txt").exists());
        assert_eq!(
            fs::read(dir.path().join("existing.txt")).unwrap(),
            b"base\n"
        );
    }

    #[tokio::test]
    async fn stage_failure_publishes_no_files_and_cleans_staging_files() {
        let dir = tempfile::tempdir().unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Add File: nested/deeper/first.txt\n",
            "+one\n",
            "*** Add File: nested/deeper/second.txt\n",
            "+two\n",
            "*** End Patch\n",
        );

        let error = execute_patch(patch, &context(dir.path()), |boundary, index, _| {
            if boundary == PatchBoundary::Stage && index == 1 {
                Err(io::Error::other("injected disk-full failure"))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert_eq!(error.code(), "TOOL_IO_ERROR");
        assert!(!dir.path().join("nested/deeper/first.txt").exists());
        assert!(!dir.path().join("nested/deeper/second.txt").exists());
        assert!(!dir.path().join("nested").exists());
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".horizoncode-patch-")
        }));
    }

    #[tokio::test]
    async fn later_base_change_during_staging_is_found_before_first_publish() {
        let dir = tempfile::tempdir().unwrap();
        let second = dir.path().join("second.txt");
        fs::write(&second, "base\n").unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Add File: first.txt\n",
            "+one\n",
            "*** Update File: second.txt\n",
            "@@\n",
            "-base\n",
            "+agent\n",
            "*** End Patch\n",
        );

        let mut raced = false;
        let error = execute_patch(patch, &context(dir.path()), |boundary, index, _| {
            if boundary == PatchBoundary::Stage && index == 0 && !raced {
                raced = true;
                fs::write(&second, "other writer\n")?;
            }
            Ok(())
        })
        .await
        .unwrap_err();
        assert_eq!(error.code(), "TOOL_CONFLICT");
        assert!(!dir.path().join("first.txt").exists());
        assert_eq!(fs::read(&second).unwrap(), b"other writer\n");
    }

    #[tokio::test]
    async fn later_publish_failure_returns_committed_and_pending_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Add File: first.txt\n",
            "+one\n",
            "*** Add File: second.txt\n",
            "+two\n",
            "*** End Patch\n",
        );

        let error = execute_patch(patch, &context(dir.path()), |boundary, index, _| {
            if boundary == PatchBoundary::Publish && index == 1 {
                Err(io::Error::other("injected publication failure"))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert_eq!(error.code(), "TOOL_PARTIAL_EFFECT");
        let message = error.model_message();
        assert!(message.contains("A first.txt "), "{message}");
        assert!(message.contains("pending=[second.txt]"), "{message}");
        assert_eq!(fs::read(dir.path().join("first.txt")).unwrap(), b"one\n");
        assert!(!dir.path().join("second.txt").exists());
    }

    #[test]
    fn snapshot_enforces_exact_and_over_byte_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded.txt");
        fs::write(&path, b"1234").unwrap();

        assert_eq!(snapshot(&path, 4).unwrap().0.unwrap(), b"1234");
        let error = snapshot(&path, 3).unwrap_err();
        assert_eq!(error.code(), "TOOL_PATCH_LIMIT");
    }

    #[tokio::test]
    async fn patch_text_over_the_cap_is_rejected_before_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let patch = "x".repeat(MAX_PATCH_TEXT_BYTES + 1);
        let error = execute_patch(&patch, &context(dir.path()), |_, _, _| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "TOOL_PATCH_LIMIT");
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn parser_rejects_an_operation_count_over_the_cap() {
        let mut patch = String::from("*** Begin Patch\n");
        for index in 0..=MAX_PATCH_OPERATIONS {
            patch.push_str(&format!("*** Add File: f{index}.txt\n+x\n"));
        }
        patch.push_str("*** End Patch\n");

        let error = parse_patch(&patch).unwrap_err();
        assert_eq!(error.code(), "TOOL_PATCH_LIMIT");
        assert!(error.to_string().contains("257 > 256"));
    }

    #[test]
    fn parser_rejects_excessive_line_and_hunk_counts_before_building_operations() {
        let too_many_lines = "x\n".repeat(MAX_PATCH_LINES + 1);
        assert_eq!(
            parse_patch(&too_many_lines).unwrap_err().code(),
            "TOOL_PATCH_LIMIT"
        );

        let too_many_hunks = "@@\n".repeat(MAX_PATCH_HUNKS + 1);
        assert_eq!(
            parse_patch(&too_many_hunks).unwrap_err().code(),
            "TOOL_PATCH_LIMIT"
        );
    }

    #[test]
    fn hunk_longer_than_file_returns_typed_error_without_panicking() {
        let hunk = Hunk {
            old: vec!["one".to_owned(), "two".to_owned()],
            new: vec!["replacement".to_owned()],
        };
        let error = apply_hunks("one\n", &[hunk], "short.txt", &mut 0).unwrap_err();
        assert_eq!(error.code(), "TOOL_INVALID_INPUT");
        assert!(error.to_string().contains("did not match"));
    }

    #[test]
    fn hunk_comparison_work_is_bounded() {
        let hunk = Hunk {
            old: vec!["line".to_owned()],
            new: vec!["replacement".to_owned()],
        };
        let mut work = MAX_PATCH_TRANSFORM_WORK_BYTES - 5;
        let error = apply_hunks("line\n", &[hunk], "file.txt", &mut work).unwrap_err();
        assert_eq!(error.code(), "TOOL_PATCH_LIMIT");
        assert!(error.to_string().contains("hunk comparison work"));
    }

    #[test]
    fn transformation_work_accepts_exact_cap_and_refuses_the_next_byte() {
        let mut exact_work = MAX_PATCH_TRANSFORM_WORK_BYTES - 1;
        assert_eq!(
            apply_hunks("x", &[], "file.txt", &mut exact_work).unwrap(),
            "x"
        );
        assert_eq!(exact_work, MAX_PATCH_TRANSFORM_WORK_BYTES);

        let mut over_work = MAX_PATCH_TRANSFORM_WORK_BYTES;
        assert_eq!(
            apply_hunks("x", &[], "file.txt", &mut over_work)
                .unwrap_err()
                .code(),
            "TOOL_PATCH_LIMIT"
        );
    }

    #[test]
    fn target_line_count_is_bounded_before_line_vector_allocation() {
        let text = "\n".repeat(MAX_PATCH_TARGET_LINES + 1);
        let hunk = Hunk {
            old: vec!["missing".to_owned()],
            new: vec!["replacement".to_owned()],
        };
        let error = apply_hunks(&text, &[hunk], "large.txt", &mut 0).unwrap_err();
        assert_eq!(error.code(), "TOOL_PATCH_LIMIT");
        assert!(error.to_string().contains("patch target lines"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn newly_added_patch_files_keep_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let patch = "*** Begin Patch\n*** Add File: private.txt\n+secret\n*** End Patch\n";
        execute_patch(patch, &context(dir.path()), |_, _, _| Ok(()))
            .await
            .unwrap();

        let mode = fs::metadata(dir.path().join("private.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
