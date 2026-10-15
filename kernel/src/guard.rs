//! Canonical authorization decisions for kernel-owned effects.
//!
//! The workspace policy admits same-Session `files.write` and `files.patch` requests that
//! have already been resolved beneath the pinned workspace handle. The decision is ASK;
//! the host may resolve that exact durable challenge after the PermissionV2 path returns.

use std::path::{Component, Path};

pub const FILES_WRITE_ID: &str = "files.write";
pub const FILES_PATCH_ID: &str = "files.patch";
pub const TERMINAL_RUN_ID: &str = "terminal.run";
pub const TERMINAL_START_ID: &str = "terminal.start";
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

/// How an effect was originated. The kind is fixed by the Canonical operation that
/// admitted the effect and is never supplied by a request body, so a model-originated
/// batch cannot present itself as a human-originated user action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectOriginKindV1 {
    /// Model-originated tool batch, bound to the Session, its turn context, and the
    /// batch/call identifiers.
    SessionBatch,
    /// Human-originated user action, bound to the authenticated principal and an explicit
    /// one-use approval. The host does not own Session identity, so a user action asserts
    /// no Session or turn-context binding.
    UserAction,
}

#[derive(Clone, Copy, Debug)]
pub struct EffectOriginV1<'a> {
    pub kind: EffectOriginKindV1,
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
    let terminal_root = request.action_id == TERMINAL_RUN_ID
        || request.action_id == TERMINAL_START_ID
            && request.resource_resolution.target == request.resource_resolution.workspace_root;
    let resolved_relative = if terminal_root {
        Some(".".to_owned())
    } else {
        request
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
            .map(|relative| relative.replace('\\', "/"))
    };
    let resource_digest = resource_digest(request);
    let supported_action = request.action_id == FILES_WRITE_ID
        || request.action_id == FILES_PATCH_ID
        || request.action_id == TERMINAL_RUN_ID
        || request.action_id == TERMINAL_START_ID;
    let session_missing = request.origin.session_id.is_empty()
        && request.action_id != TERMINAL_RUN_ID
        && request.action_id != TERMINAL_START_ID;
    // The origin kind decides which binding the effect must carry. A model-originated
    // batch always requires its Session and turn-context binding, including for
    // `terminal.run`; a human-originated user action requires the authenticated principal
    // and its explicit approval instead, and must not carry a turn context.
    let origin_binding_missing = match request.origin.kind {
        EffectOriginKindV1::SessionBatch => {
            request.origin.session_id.is_empty() || !is_sha256_digest(request.turn_context_digest)
        }
        EffectOriginKindV1::UserAction => !request.turn_context_digest.is_empty(),
    };
    let reason_code = if !supported_action {
        Some("unsupported_action")
    } else if request.origin.kind == EffectOriginKindV1::UserAction
        && request.action_id != TERMINAL_RUN_ID
        && request.action_id != TERMINAL_START_ID
    {
        Some("unsupported_user_action")
    } else if request.principal.is_empty()
        || request.principal.chars().any(char::is_control)
        || session_missing
        || origin_binding_missing
        || request.request_id.is_empty()
        || request.request_id != request.origin.batch_id
        || request.origin.batch_id.is_empty()
        || request.origin.call_id.is_empty()
    {
        Some("invalid_principal_or_origin")
    } else if !is_digest(request.argument_digest)
        || !is_digest(request.resource_resolution.workspace_binding)
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
    let origin_kind = match request.origin.kind {
        EffectOriginKindV1::SessionBatch => b"session_batch".as_slice(),
        EffectOriginKindV1::UserAction => b"user_action".as_slice(),
    };
    for value in [
        request.request_id.as_bytes(),
        request.principal.as_bytes(),
        origin_kind,
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
                kind: EffectOriginKindV1::SessionBatch,
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
    #[test]
    fn authenticated_principal_is_independent_of_session_and_bound_to_decision() {
        let root = Path::new("/workspace");
        let mut request = request(root, Path::new("/workspace/file.txt"), "file.txt");
        request.principal = "host_os_uid:1000";
        let decision = authorize(&request, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);
        let first = intent_digest(&request, &decision);

        request.principal = "server_auth:alice";
        let other_decision = authorize(&request, "challenge_1");
        assert_eq!(other_decision.decision, DecisionKind::Ask);
        assert_ne!(first, intent_digest(&request, &other_decision));
    }

    #[test]
    fn session_batch_terminal_run_requires_its_session_and_turn_context_binding() {
        let root = Path::new("/workspace");
        let mut bound = request(root, root, ".");
        bound.action_id = TERMINAL_RUN_ID;
        let decision = authorize(&bound, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        let mut sessionless = bound;
        sessionless.origin.session_id = "";
        let decision = authorize(&sessionless, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        let mut contextless = bound;
        contextless.turn_context_digest = "";
        let decision = authorize(&contextless, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        let mut unbound = sessionless;
        unbound.turn_context_digest = "";
        let decision = authorize(&unbound, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));
    }

    #[test]
    fn user_action_origin_needs_only_the_principal_and_cannot_claim_a_batch_or_write() {
        let root = Path::new("/workspace");
        let mut user = request(root, root, ".");
        user.action_id = TERMINAL_RUN_ID;
        user.origin.kind = EffectOriginKindV1::UserAction;
        user.origin.session_id = "ses_1";
        user.turn_context_digest = "";
        let decision = authorize(&user, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        // A user action carries no turn context, so a batch-shaped user origin is denied.
        let mut batch_shaped = user;
        batch_shaped.turn_context_digest = TURN_CONTEXT_DIGEST;
        let decision = authorize(&batch_shaped, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        // The user origin never authorizes a filesystem effect.
        let mut write = user;
        write.action_id = FILES_WRITE_ID;
        write.resource_resolution.target = Path::new("/workspace/file.txt");
        write.resource_resolution.resource = "file.txt";
        let decision = authorize(&write, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("unsupported_user_action"));

        // The origin kind is bound into the decision digest.
        let batch = request(root, root, ".");
        let mut batch = batch;
        batch.action_id = TERMINAL_RUN_ID;
        let batch_digest = intent_digest(&batch, &authorize(&batch, "challenge_1"));
        let user_digest = intent_digest(&user, &authorize(&user, "challenge_1"));
        assert_ne!(batch_digest, user_digest);
    }
}
