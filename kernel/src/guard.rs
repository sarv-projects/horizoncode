//! Canonical authorization decisions for kernel-owned effects.
//!
//! The workspace policy admits same-Session `files.write` and `files.patch` requests that
//! have already been resolved beneath the pinned workspace handle. The decision is ASK;
//! the host may resolve that exact durable challenge after the PermissionV2 path returns.

use std::path::{Component, Path};

pub const FILES_WRITE_ID: &str = "files.write";
pub const FILES_PATCH_ID: &str = "files.patch";
pub const WORKSPACE_WRITE_POLICY_ID: &str = "workspace-write.local.v1";
const POLICY_BYTES: &[u8] =
    b"horizoncode.guard.workspace-write.local.v1:ask;beneath-root;no-symlink;no-hardlink;one-use";
const GUARANTEES: &[&str] = &[
    "beneath_workspace_root",
    "no_symlink",
    "no_hardlink",
    "one_use",
];

/// Bind authorization to the canonical workspace path and the opened directory inode.
pub fn workspace_binding(root: &Path, device: u64, inode: u64) -> String {
    digest(&[
        b"horizoncode.workspace-binding.v1",
        root.as_os_str().as_encoded_bytes(),
        &device.to_be_bytes(),
        &inode.to_be_bytes(),
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionKind {
    Ask,
    Deny,
}

#[derive(Clone, Copy, Debug)]
pub struct EffectOriginV1<'a> {
    pub session_id: &'a str,
    pub batch_id: &'a str,
    pub call_id: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct ResourceResolutionV1<'a> {
    pub workspace_root: &'a Path,
    pub workspace_binding: &'a str,
    pub target: &'a Path,
    pub resource: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct AuthorizationRequestV1<'a> {
    pub request_id: &'a str,
    pub principal: &'a str,
    pub origin: EffectOriginV1<'a>,
    pub action_id: &'a str,
    /// BLAKE3 digest of the complete proposed arguments, never raw tool content.
    pub argument_digest: &'a str,
    pub turn_context_digest: &'a str,
    pub resource_resolution: ResourceResolutionV1<'a>,
    pub policy_snapshot_ids: &'a [&'a str],
    pub requested_guarantees: &'a [&'a str],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardDecisionV1 {
    pub decision_id: String,
    pub decision: DecisionKind,
    pub policy_digest: String,
    pub resource_digest: String,
    pub normalized_action: String,
    pub reason_code: Option<&'static str>,
}

pub fn authorize(request: &AuthorizationRequestV1<'_>, decision_id: &str) -> GuardDecisionV1 {
    let policy_digest = digest(&[POLICY_BYTES]);
    let normalized_action = request.action_id.to_owned();
    let resolved_relative = request
        .resource_resolution
        .target
        .strip_prefix(request.resource_resolution.workspace_root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .filter(|relative| {
            relative
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        })
        .and_then(Path::to_str)
        .map(|relative| relative.replace('\\', "/"));
    let resource_digest = resource_digest(request);

    let supported_action =
        request.action_id == FILES_WRITE_ID || request.action_id == FILES_PATCH_ID;
    let reason_code = if !supported_action {
        Some("unsupported_action")
    } else if request.principal != request.origin.session_id
        || request.request_id.is_empty()
        || request.request_id != request.origin.batch_id
        || request.origin.call_id.is_empty()
    {
        Some("invalid_principal_or_origin")
    } else if !is_digest(request.argument_digest)
        || !is_digest(request.resource_resolution.workspace_binding)
        || !is_sha256_digest(request.turn_context_digest)
    {
        Some("invalid_effect_digest")
    } else if resolved_relative.as_deref() != Some(request.resource_resolution.resource) {
        Some("resource_outside_workspace")
    } else if request.policy_snapshot_ids != [WORKSPACE_WRITE_POLICY_ID]
        || request.requested_guarantees != GUARANTEES
    {
        Some("unsupported_policy_or_guarantee")
    } else {
        None
    };

    GuardDecisionV1 {
        decision_id: decision_id.to_owned(),
        decision: if reason_code.is_some() {
            DecisionKind::Deny
        } else {
            DecisionKind::Ask
        },
        policy_digest,
        resource_digest,
        normalized_action,
        reason_code,
    }
}

/// Digest the authorization decision with every input that can change its authority.
pub fn intent_digest(request: &AuthorizationRequestV1<'_>, decision: &GuardDecisionV1) -> String {
    let mut hasher = blake3::Hasher::new();
    let decision_kind = match decision.decision {
        DecisionKind::Ask => b"ASK".as_slice(),
        DecisionKind::Deny => b"DENY".as_slice(),
    };
    let reason_code = decision.reason_code.unwrap_or("");
    for value in [
        request.request_id.as_bytes(),
        request.principal.as_bytes(),
        request.origin.session_id.as_bytes(),
        request.origin.batch_id.as_bytes(),
        request.origin.call_id.as_bytes(),
        request.action_id.as_bytes(),
        request.argument_digest.as_bytes(),
        request
            .resource_resolution
            .workspace_root
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.workspace_binding.as_bytes(),
        request
            .resource_resolution
            .target
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.resource.as_bytes(),
        decision.decision_id.as_bytes(),
        decision.policy_digest.as_bytes(),
        decision.resource_digest.as_bytes(),
        decision_kind,
        request.turn_context_digest.as_bytes(),
        reason_code.as_bytes(),
    ] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    for value in request
        .policy_snapshot_ids
        .iter()
        .chain(request.requested_guarantees)
    {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

/// Bind the full tool argument tuple without storing the raw content.
pub fn argument_digest(
    session_id: &str,
    batch_id: &str,
    call_id: &str,
    action_id: &str,
    requested_path: &str,
    content_digest: &str,
) -> String {
    digest(&[
        session_id.as_bytes(),
        batch_id.as_bytes(),
        call_id.as_bytes(),
        action_id.as_bytes(),
        requested_path.as_bytes(),
        content_digest.as_bytes(),
    ])
}

fn resource_digest(request: &AuthorizationRequestV1<'_>) -> String {
    digest(&[
        request.principal.as_bytes(),
        request.origin.session_id.as_bytes(),
        request.action_id.as_bytes(),
        request
            .resource_resolution
            .workspace_root
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.workspace_binding.as_bytes(),
        request
            .resource_resolution
            .target
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.resource.as_bytes(),
    ])
}

fn digest(values: &[&[u8]]) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in values {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
pub(crate) fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const ARGUMENT_DIGEST: &str =
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const WORKSPACE_BINDING: &str =
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TURN_CONTEXT_DIGEST: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    fn request<'a>(
        root: &'a Path,
        target: &'a Path,
        resource: &'a str,
    ) -> AuthorizationRequestV1<'a> {
        AuthorizationRequestV1 {
            request_id: "batch_1",
            principal: "ses_1",
            origin: EffectOriginV1 {
                session_id: "ses_1",
                batch_id: "batch_1",
                call_id: "call_1",
            },
            action_id: FILES_WRITE_ID,
            argument_digest: ARGUMENT_DIGEST,
            turn_context_digest: TURN_CONTEXT_DIGEST,
            resource_resolution: ResourceResolutionV1 {
                workspace_root: root,
                workspace_binding: WORKSPACE_BINDING,
                target,
                resource,
            },
            policy_snapshot_ids: &[WORKSPACE_WRITE_POLICY_ID],
            requested_guarantees: GUARANTEES,
        }
    }

    #[test]
    fn asks_for_one_bound_workspace_write_and_denies_outside_resources() {
        let root = Path::new("/workspace");
        let target = Path::new("/workspace/file.txt");
        let authorized_request = request(root, target, "file.txt");
        let decision = authorize(&authorized_request, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.normalized_action, FILES_WRITE_ID);
        assert_eq!(decision.reason_code, None);

        let outside = request(root, Path::new("/outside/file.txt"), "file.txt");
        let decision = authorize(&outside, "challenge_2");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("resource_outside_workspace"));
    }

    #[test]
    fn authorization_digest_changes_when_a_bound_argument_changes() {
        let root = Path::new("/workspace");
        let first = request(root, Path::new("/workspace/one.txt"), "one.txt");
        let first_decision = authorize(&first, "challenge_1");
        let first_digest = intent_digest(&first, &first_decision);

        let second = request(root, Path::new("/workspace/two.txt"), "two.txt");
        let second_decision = authorize(&second, "challenge_1");
        assert_ne!(first_digest, intent_digest(&second, &second_decision));

        let mut changed_context = first;
        changed_context.turn_context_digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let context_decision = authorize(&changed_context, "challenge_1");
        assert_ne!(
            first_digest,
            intent_digest(&changed_context, &context_decision)
        );
    }
}
