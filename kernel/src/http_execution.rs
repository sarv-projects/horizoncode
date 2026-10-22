//! Guarded outbound HTTP execution primitives.
//!
//! This module provides bounded fixed-route HTTP/MCP transport for HostKernel's
//! authenticated Guard/lease/receipt lifecycle. It owns no arbitrary destinations,
//! redirects, or provider fallback policy. Credentialed routes remain unavailable
//! until a trusted SecretBroker resolver exists.

use std::future::Future;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use ring::rand::{SecureRandom, SystemRandom};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::request_cancellation::RequestCancellation;

pub const MAX_HTTP_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_HTTP_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_HTTP_TIMEOUT_MS: u64 = 30_000;
pub const MAX_RETRY_AFTER_MS: u64 = 60_000;
pub const MAX_HTTP_CONCURRENT_REQUESTS: usize = 4;
pub const MAX_HTTP_DNS_ADDRESSES: usize = 16;
pub const MAX_HTTP_DNS_TIME: Duration = Duration::from_secs(3);

/// Exact, secret-free identity pinned by HostKernel before one managed model
/// request may be sent. The caller projection is still untrusted: HostKernel
/// must independently check the live Attempt/profile, consent and budget before
/// using this value, then persist the returned digest with its OwnerLog record.
/// This helper deliberately carries no endpoint URL, provider body, credential
/// bytes, or SecretBroker use lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedProviderAuthorizationPinsV1 {
    /// Stable Attempt identity used to derive the unique provider-request ID.
    pub attempt_id: String,
    pub managed_attempt_digest: String,
    pub owner_epoch: u64,
    pub provider_request_id: String,
    pub request_id: String,
    pub request_sequence: u64,
    pub context_selection_digest: String,
    /// Digest of the normalized Horizon request approved by the managed run.
    pub request_digest: String,
    /// SecretBroker operation digest for the exact credential-use operation.
    /// This uses SHA-256 to match the existing Core SecretBroker contract.
    pub operation_digest: String,
    /// Digest of the exact canonical SDK transport request prepared for this
    /// send, including the fixed method, destination, body, non-secret headers,
    /// and credential-header profile. It is deliberately distinct from
    /// `request_digest`: route adaptation must not change either binding.
    pub transport_request_digest: String,
    pub provider_id: String,
    pub model_id: String,
    pub harness_id: String,
    pub route_id: String,
    pub endpoint_revision: String,
    pub credential_ref: Option<String>,
    pub guard_challenge_id: String,
    pub capability_lease_digest: String,
    /// Attempt-bound digest of effective permissions after Task/Spec, pinned
    /// AgentProfileV2 and current Guard policy intersection. This is distinct
    /// from the capability ceiling digest.
    pub permission_scope_digest: String,
}

/// HostKernel-resolved Guard facts for the internal `providers.infer` action.
/// This is intentionally not decoded from model ToolBatch input. The selected
/// route and all three request digests come from P6's frozen Core projection;
/// budget authority and Attempt facts are re-resolved from Rust-owned managed
/// state before this binding is constructed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedProviderEffectBindingV1 {
    pub pins: ManagedProviderAuthorizationPinsV1,
    pub principal: String,
    pub session_id: String,
    pub location_id: String,
    pub batch_id: String,
    pub call_id: String,
    pub workspace_revision: String,
    pub budget_lease_id: String,
    pub budget_authority_digest: String,
    pub max_tokens: u64,
    pub max_cost_micros: u64,
}

/// HostKernel-minted pre-approval facts for one managed inference request.
/// Guard challenge and lease are intentionally absent here: they are created
/// after this prepare is durably admitted and explicit approval completes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedProviderPrepareBindingV1 {
    pub attempt_id: String,
    pub managed_attempt_digest: String,
    pub owner_epoch: u64,
    pub provider_request_id: String,
    pub request_id: String,
    pub request_sequence: u64,
    pub context_selection_digest: String,
    pub request_digest: String,
    pub operation_digest: String,
    pub transport_request_digest: String,
    pub provider_id: String,
    pub model_id: String,
    pub harness_id: String,
    pub route_id: String,
    pub endpoint_revision: String,
    pub credential_ref: Option<String>,
    pub permission_scope_digest: String,
    pub principal: String,
    pub session_id: String,
    pub location_id: String,
    pub batch_id: String,
    pub call_id: String,
    pub workspace_revision: String,
    pub budget_lease_id: String,
    pub budget_authority_digest: String,
    pub max_tokens: u64,
    pub max_cost_micros: u64,
}

impl ManagedProviderPrepareBindingV1 {
    pub(crate) fn digest(&self) -> Result<String, HttpExecutionErrorV1> {
        let valid_id = |value: &str| !value.is_empty() && value.len() <= 256
            && !value.chars().any(|c| c.is_whitespace() || c.is_control());
        let valid_digest = |value: &str, prefix: &str| value.strip_prefix(prefix).is_some_and(|hex|
            hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        if self.owner_epoch == 0 || !(1..=1024).contains(&self.request_sequence)
            || self.max_tokens == 0 || !valid_id(&self.attempt_id) || !valid_id(&self.provider_request_id)
            || !valid_id(&self.request_id) || !valid_id(&self.provider_id) || !valid_id(&self.model_id)
            || !valid_id(&self.harness_id) || !valid_id(&self.route_id)
            || !valid_id(&self.principal) || !valid_id(&self.session_id) || !valid_id(&self.location_id)
            || !valid_id(&self.batch_id) || !valid_id(&self.call_id) || !valid_id(&self.budget_lease_id)
            || self.credential_ref.as_deref().is_some_and(|v| !valid_id(v))
            || !valid_digest(&self.managed_attempt_digest, "blake3:")
            || !valid_digest(&self.context_selection_digest, "blake3:")
            || !valid_digest(&self.request_digest, "blake3:")
            || !valid_digest(&self.transport_request_digest, "blake3:")
            || !valid_digest(&self.operation_digest, "sha256:")
            || !valid_digest(&self.endpoint_revision, "blake3:")
            || !valid_digest(&self.permission_scope_digest, "blake3:")
            || !valid_digest(&self.workspace_revision, "blake3:")
            || !valid_digest(&self.budget_authority_digest, "blake3:")
        { return Err(HttpExecutionErrorV1::InvalidRequest); }
        let sequence = self.request_sequence.to_string();
        let epoch = self.owner_epoch.to_string();
        let max_tokens = self.max_tokens.to_string();
        let max_cost = self.max_cost_micros.to_string();
        let fields = [self.attempt_id.as_str(), self.managed_attempt_digest.as_str(), epoch.as_str(),
            self.provider_request_id.as_str(), self.request_id.as_str(), sequence.as_str(),
            self.context_selection_digest.as_str(), self.request_digest.as_str(), self.operation_digest.as_str(),
            self.transport_request_digest.as_str(), self.provider_id.as_str(), self.model_id.as_str(),
            self.harness_id.as_str(), self.route_id.as_str(), self.endpoint_revision.as_str(),
            self.credential_ref.as_deref().unwrap_or(""), self.permission_scope_digest.as_str(),
            self.principal.as_str(), self.session_id.as_str(), self.location_id.as_str(), self.batch_id.as_str(),
            self.call_id.as_str(), self.workspace_revision.as_str(), self.budget_lease_id.as_str(),
            self.budget_authority_digest.as_str(), max_tokens.as_str(), max_cost.as_str()];
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.providers-infer.prepare-binding.v1\0");
        for field in fields { hasher.update(&(field.len() as u64).to_be_bytes()); hasher.update(field.as_bytes()); }
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }
}

impl ManagedProviderEffectBindingV1 {
    pub(crate) fn prepare_digest(&self) -> Result<String, HttpExecutionErrorV1> {
        let p = &self.pins;
        ManagedProviderPrepareBindingV1 {
            attempt_id: p.attempt_id.clone(), managed_attempt_digest: p.managed_attempt_digest.clone(),
            owner_epoch: p.owner_epoch, provider_request_id: p.provider_request_id.clone(), request_id: p.request_id.clone(),
            request_sequence: p.request_sequence, context_selection_digest: p.context_selection_digest.clone(),
            request_digest: p.request_digest.clone(), operation_digest: p.operation_digest.clone(),
            transport_request_digest: p.transport_request_digest.clone(), provider_id: p.provider_id.clone(),
            model_id: p.model_id.clone(), harness_id: p.harness_id.clone(), route_id: p.route_id.clone(),
            endpoint_revision: p.endpoint_revision.clone(), credential_ref: p.credential_ref.clone(),
            permission_scope_digest: p.permission_scope_digest.clone(),
            principal: self.principal.clone(), session_id: self.session_id.clone(), location_id: self.location_id.clone(),
            batch_id: self.batch_id.clone(), call_id: self.call_id.clone(), workspace_revision: self.workspace_revision.clone(),
            budget_lease_id: self.budget_lease_id.clone(), budget_authority_digest: self.budget_authority_digest.clone(),
            max_tokens: self.max_tokens, max_cost_micros: self.max_cost_micros,
        }.digest()
    }
    pub(crate) fn digest(&self) -> Result<String, HttpExecutionErrorV1> {
        let pins_digest = self.pins.digest()?;
        let valid_id = |value: &str| !value.is_empty() && value.len() <= 256
            && !value.chars().any(|c| c.is_whitespace() || c.is_control());
        let valid_digest = |value: &str| value.strip_prefix("blake3:").is_some_and(|hex|
            hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        if !valid_id(&self.principal) || !valid_id(&self.session_id) || !valid_id(&self.location_id)
            || !valid_id(&self.batch_id) || !valid_id(&self.call_id) || !valid_id(&self.budget_lease_id)
            || !valid_digest(&self.workspace_revision) || !valid_digest(&self.budget_authority_digest)
            || self.max_tokens == 0
            || self.pins.managed_attempt_digest.is_empty()
        { return Err(HttpExecutionErrorV1::InvalidRequest); }
        let max_tokens = self.max_tokens.to_string();
        let max_cost_micros = self.max_cost_micros.to_string();
        let fields = [
            pins_digest.as_str(), self.principal.as_str(), self.session_id.as_str(), self.location_id.as_str(),
            self.batch_id.as_str(), self.call_id.as_str(), self.workspace_revision.as_str(),
            self.budget_lease_id.as_str(), self.budget_authority_digest.as_str(),
            max_tokens.as_str(), max_cost_micros.as_str(),
        ];
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.providers-infer.effect-binding.v1\0");
        for field in fields { hasher.update(&(field.len() as u64).to_be_bytes()); hasher.update(field.as_bytes()); }
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }
}

/// Opaque one-use authorization returned only after HostKernel durably records
/// the DISPATCHING OwnerLog transition. The raw token is never persisted; only
/// its digest and exact binding are stored in EffectHost.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedProviderSendAuthorizationV1 {
    pub token: String,
    pub provider_request_id: String,
    pub effect_id: String,
    pub prepare_digest: String,
    pub dispatch_digest: String,
    pub binding_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManagedProviderInferenceRecoveryV1 {
    NotDispatched,
    Unknown,
    Settled { receipt_digest: String, response_digest: String, usage_digest: String, assistant_entry_id: String },
}

impl ManagedProviderAuthorizationPinsV1 {
    /// Validate bounded canonical identity and compute the digest OwnerLog must
    /// bind at PREPARED and compare again at DISPATCHING. Exact replay is safe;
    /// any changed route, request, scope or authority conflicts before send.
    pub(crate) fn digest(&self) -> Result<String, HttpExecutionErrorV1> {
        fn valid_id(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 256
                && !value.chars().any(|character| character.is_whitespace() || character.is_control())
        }
        fn valid_hex_digest(value: &str, prefix: &str) -> bool {
            value.strip_prefix(prefix).is_some_and(|digest| {
                digest.len() == 64
                    && digest.bytes().all(|byte| {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                    })
            })
        }
        fn valid_sha256_digest(value: &str) -> bool {
            value.strip_prefix("sha256:").is_some_and(|digest| {
                digest.len() == 64
                    && digest.bytes().all(|byte| {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                    })
            })
        }
        if !valid_hex_digest(&self.managed_attempt_digest, "blake3:")
            || !valid_id(&self.attempt_id)
            || self.owner_epoch == 0
            || !valid_id(&self.provider_request_id)
            || !valid_id(&self.request_id)
            || !(1..=1024).contains(&self.request_sequence)
            || !valid_hex_digest(&self.context_selection_digest, "blake3:")
            || !valid_hex_digest(&self.request_digest, "blake3:")
            || !valid_sha256_digest(&self.operation_digest)
            || !valid_hex_digest(&self.transport_request_digest, "blake3:")
            || !valid_id(&self.provider_id)
            || !valid_id(&self.model_id)
            || !valid_id(&self.harness_id)
            || self.route_id.len() != 68
            || !self.route_id.starts_with("llm_")
            || !self.route_id[4..].bytes().all(|byte| {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            })
            || !valid_hex_digest(&self.endpoint_revision, "blake3:")
            || self.credential_ref.as_deref().is_some_and(|value| !valid_id(value))
            || !valid_id(&self.guard_challenge_id)
            || !valid_hex_digest(&self.capability_lease_digest, "blake3:")
            || !valid_hex_digest(&self.permission_scope_digest, "blake3:")
        {
            return Err(HttpExecutionErrorV1::InvalidRequest);
        }

        // Use fixed-order, length-prefixed UTF-8 fields so the digest definition
        // remains independent of a JSON serializer or map iteration order.
        let owner_epoch = self.owner_epoch.to_string();
        let request_sequence = self.request_sequence.to_string();
        let fields = [
            self.managed_attempt_digest.as_str(),
            self.attempt_id.as_str(),
            owner_epoch.as_str(),
            self.provider_request_id.as_str(),
            self.request_id.as_str(),
            request_sequence.as_str(),
            self.context_selection_digest.as_str(),
            self.request_digest.as_str(),
            self.operation_digest.as_str(),
            self.transport_request_digest.as_str(),
            self.provider_id.as_str(),
            self.model_id.as_str(),
            self.harness_id.as_str(),
            self.route_id.as_str(),
            self.endpoint_revision.as_str(),
            self.credential_ref.as_deref().unwrap_or(""),
            self.guard_challenge_id.as_str(),
            self.capability_lease_digest.as_str(),
            self.permission_scope_digest.as_str(),
        ];
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.managed-provider-authorization.v1\0");
        for field in fields {
            let bytes = field.as_bytes();
            hasher.update(&(bytes.len() as u64).to_be_bytes());
            hasher.update(bytes);
        }
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }
}

/// Mint opaque non-secret bearer authority for exactly one durable
/// `managed_provider.begin` transition. The caller must persist this value with
/// the matching OwnerLog DISPATCHING record before returning it to Core. Exact
/// retries after persistence must never return it again. This is not a
/// SecretBroker lease and contains no credential material.
pub(crate) fn mint_managed_provider_send_authorization(
) -> Result<String, HttpExecutionErrorV1> {
    let mut random = [0u8; 32];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    Ok(format!("blake3:{}", blake3::hash(&random).to_hex()))
}

/// Validate a HostKernel send-authorization projection before the existing
/// first-party provider adapter enters SecretBroker. The durable OwnerLog is
/// still responsible for proving the token was returned once for this exact
/// provider request; this decoder only enforces the strict, non-secret shape.
pub(crate) fn validate_managed_provider_send_authorization(
    pins: &ManagedProviderAuthorizationPinsV1,
    provider_request_id: &str,
    prepare_digest: &str,
    pins_digest: &str,
    send_authorization: &str,
) -> Result<(), HttpExecutionErrorV1> {
    let valid_id = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && !value.chars().any(|character| character.is_whitespace() || character.is_control())
    };
    let valid_digest = |value: &str| {
        value.strip_prefix("blake3:").is_some_and(|digest| {
            digest.len() == 64
                && digest.bytes().all(|byte| {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                })
        })
    };
    let expected_pins_digest = pins.digest()?;
    let expected_provider_request_id = format!("mpr_{}_{}", pins.attempt_id, pins.request_sequence);
    if !valid_id(provider_request_id)
        || provider_request_id != expected_provider_request_id.as_str()
        || pins.provider_request_id.as_str() != provider_request_id
        || !valid_digest(prepare_digest)
        || !valid_digest(pins_digest)
        || pins_digest != expected_pins_digest.as_str()
        || !valid_digest(send_authorization)
    {
        return Err(HttpExecutionErrorV1::InvalidRequest);
    }
    Ok(())
}

/// Compile-time allowlist for V1 web-search routes. Route IDs are owned by
/// Core's explicit configuration; the caller never supplies a destination.
/// Anonymous MCP routes use a separate fixed protocol allowlist below. The
/// routes remain unavailable to callers until HostKernel Guard admission,
/// one-use leases, durable receipts and SecretBroker composition are wired.
pub fn fixed_web_search_route(route_id: &str) -> Option<HttpRoutePolicyV1> {
    let (provider_id, host, path_prefix) = match route_id {
        "web.search.exa" => ("exa", "api.exa.ai", "/search"),
        "web.search.youcom" => ("youcom", "ydc-index.io", "/v1/search"),
        "web.search.tavily" => ("tavily", "api.tavily.com", "/search"),
        "web.search.firecrawl" => ("firecrawl", "api.firecrawl.dev", "/v2/search"),
        "web.search.parallel" => ("parallel", "api.parallel.ai", "/v1/search"),
        "web.search.brave" => ("brave", "api.search.brave.com", "/res/v1/web/search"),
        _ => return None,
    };
    Some(HttpRoutePolicyV1 {
        provider_id: provider_id.to_owned(),
        route_id: route_id.to_owned(),
        host: host.to_owned(),
        port: 443,
        resolved_addresses: Vec::new(),
        path_prefix: path_prefix.to_owned(),
        max_request_bytes: MAX_HTTP_REQUEST_BYTES,
        max_response_bytes: MAX_HTTP_RESPONSE_BYTES,
        timeout_ms: 12_000,
    })
}

/// Construct the fixed Brave GET target from the canonical bounded request. The
/// caller cannot select query parameters, host, or path independently.
pub fn fixed_brave_search_target(query: &str, limit: u8) -> Option<String> {
    if query.trim() != query || query.is_empty() || query.len() > 2_000 || !(1..=10).contains(&limit) {
        return None;
    }
    let mut target = reqwest::Url::parse("https://api.search.brave.com/res/v1/web/search").ok()?;
    target.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &limit.to_string())
        .append_pair("safesearch", "moderate");
    Some(target.to_string())
}

/// Host-owned request projection for one credentialed search attempt. The
/// projection contains no secret bytes or credential header value. Core's
/// in-process SecretBroker transport may add the named credential header only
/// while consuming the exact one-use lease bound to `operation_digest`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixedCredentialedSearchRequestV1 {
    pub provider_id: String,
    pub route_id: String,
    pub method: &'static str,
    pub destination: String,
    pub body: String,
    /// Non-credential headers only; currently POST profiles use JSON content.
    pub headers: Vec<(String, String)>,
    pub credential_header_name: &'static str,
    pub credential_header_prefix: &'static str,
    pub operation_digest: String,
}

/// Translate the Guard-approved bounded query into one of the six fixed BYO
/// provider requests from §42. No caller-supplied URL, method, header, or body
/// is accepted. The caller must separately prove the matching opaque
/// SecretRef and aggregate route attempt before exposing this projection.
pub fn fixed_credentialed_search_request(
    route_key: &str,
    query: &str,
    limit: u8,
) -> Option<FixedCredentialedSearchRequestV1> {
    if query.trim() != query || query.is_empty() || query.len() > 2_000 || !(1..=10).contains(&limit) {
        return None;
    }
    let (provider_id, method, base, credential_header_name, credential_header_prefix, body) =
        match route_key {
            "brave" => {
                let mut target = reqwest::Url::parse(
                    "https://api.search.brave.com/res/v1/web/search",
                ).ok()?;
                target.query_pairs_mut()
                    .append_pair("q", query)
                    .append_pair("count", &limit.to_string())
                    .append_pair("safesearch", "moderate");
                ("brave", "GET", target.to_string(), "x-subscription-token", "", String::new())
            }
            "exa" => ("exa", "POST", "https://api.exa.ai/search".to_owned(), "x-api-key", "",
                serde_json::to_string(&serde_json::json!({"query":query,"numResults":limit,
                    "contents":{"text":{"maxCharacters":1200}}})).ok()?),
            "youcom" => ("youcom", "POST", "https://ydc-index.io/v1/search".to_owned(), "x-api-key", "",
                serde_json::to_string(&serde_json::json!({"query":query,"count":limit})).ok()?),
            "tavily" => ("tavily", "POST", "https://api.tavily.com/search".to_owned(), "authorization", "Bearer ",
                serde_json::to_string(&serde_json::json!({"query":query,"search_depth":"basic",
                    "max_results":limit,"include_answer":false,"include_raw_content":false})).ok()?),
            "firecrawl" => ("firecrawl", "POST", "https://api.firecrawl.dev/v2/search".to_owned(), "authorization", "Bearer ",
                serde_json::to_string(&serde_json::json!({"query":query,"limit":limit,"sources":["web"],
                    "safe":true,"highlights":true})).ok()?),
            "parallel" => ("parallel", "POST", "https://api.parallel.ai/v1/search".to_owned(), "x-api-key", "",
                serde_json::to_string(&serde_json::json!({"objective":query,"search_queries":[query],
                    "mode":"fast","max_chars_total":12000})).ok()?),
            _ => return None,
        };
    if body.len() > MAX_HTTP_REQUEST_BYTES { return None; }
    let headers = if method == "POST" {
        vec![("content-type".to_owned(), "application/json".to_owned())]
    } else {
        Vec::new()
    };
    let operation_digest = fixed_provider_request_digest(
        provider_id, method, &base, credential_header_name, credential_header_prefix,
        &headers, &body,
    );
    Some(FixedCredentialedSearchRequestV1 {
        provider_id: provider_id.to_owned(),
        route_id: format!("web.search.{route_key}"),
        method,
        destination: base,
        body,
        headers,
        credential_header_name,
        credential_header_prefix,
        operation_digest,
    })
}

/// Match the existing first-party provider transport's canonical request
/// digest. Headers are lowercased, sorted, and newline-delimited; the
/// credential value is never included, only the fixed header name/prefix.
fn fixed_provider_request_digest(
    provider_id: &str,
    method: &str,
    destination: &str,
    credential_header_name: &str,
    credential_header_prefix: &str,
    headers: &[(String, String)],
    body: &str,
) -> String {
    let mut canonical_headers = headers.iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .collect::<Vec<_>>();
    canonical_headers.sort_by(|left, right| left.0.cmp(&right.0));
    let header_bytes = canonical_headers.into_iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>().join("\n");
    let input = format!(
        "provider-request-v1\n{provider_id}\n{method}\n{destination}\n{credential_header_name}\n{credential_header_prefix}\n{header_bytes}\n{body}"
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
    let mut hex = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() { use std::fmt::Write as _; let _ = write!(hex, "{byte:02x}"); }
    format!("sha256:{hex}")
}

/// Static endpoints for the four V1 anonymous MCP search routes. This is a
/// separate protocol allowlist: the regular POST adapter never accepts these
/// IDs or caller supplied MCP methods/headers.
pub fn fixed_web_search_mcp_route(route_id: &str) -> Option<HttpRoutePolicyV1> {
    let (provider_id, host, path_prefix) = match route_id {
        "web.search.exa_keyless" => ("exa", "mcp.exa.ai", "/mcp"),
        "web.search.youcom_free" => ("youcom", "api.you.com", "/mcp?profile=free"),
        "web.search.firecrawl_keyless" => ("firecrawl", "mcp.firecrawl.dev", "/v2/mcp"),
        "web.search.parallel_keyless" => ("parallel", "search.parallel.ai", "/mcp"),
        _ => return None,
    };
    Some(HttpRoutePolicyV1 {
        provider_id: provider_id.to_owned(),
        route_id: route_id.to_owned(),
        host: host.to_owned(),
        port: 443,
        resolved_addresses: Vec::new(),
        path_prefix: path_prefix.to_owned(),
        max_request_bytes: MAX_HTTP_REQUEST_BYTES,
        max_response_bytes: MAX_HTTP_RESPONSE_BYTES,
        timeout_ms: 12_000,
    })
}

/// Validate the schema-bounded host-selected domain filter again at the
/// transport boundary. `None` means no filter; an explicitly empty list is a
/// closed allowlist and is rejected before DNS or socket creation.
fn valid_search_domains(domains: Option<&[String]>) -> bool {
    let Some(domains) = domains else { return true };
    if domains.len() > 100 { return false; }
    let mut seen = std::collections::BTreeSet::new();
    domains.iter().all(|domain| {
        if domain.is_empty() || domain.len() > 253 || !domain.is_ascii() || !seen.insert(domain) {
            return false;
        }
        let host = domain.strip_prefix("*.").unwrap_or(domain);
        !host.is_empty() && !host.ends_with('.') && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    })
}

fn search_domain_filter_is_dispatchable(domains: Option<&[String]>) -> bool {
    valid_search_domains(domains) && domains.is_none_or(|values| !values.is_empty())
}

/// Encode an OR of validated site filters for the MCP providers whose stable
/// search-tool schema has no host-only include-domain field. Callers must first
/// validate `domains`; retaining the raw query for an absent filter avoids any
/// change to existing search behavior.
fn search_query_with_domains(query: &str, domains: Option<&[String]>) -> String {
    let Some(domains) = domains.filter(|values| !values.is_empty()) else {
        return query.to_owned();
    };
    let sites = domains.iter().map(|domain| format!("site:{domain}"))
        .collect::<Vec<_>>().join(" OR ");
    format!("({query}) ({sites})")
}

/// Execute exactly one fixed V1 search tool call through the stateless HTTP
/// transport lifecycle. Initialize, initialized notification, and tools/call
/// share one already-spent HostKernel lease; any ambiguity after initialize is
/// an UNKNOWN effect and must not be retried with that lease.
fn execute_mcp_search_pinned(
    route: &HttpRoutePolicyV1,
    effect_id: &str,
    challenge_id: &str,
    lease_digest: &str,
    query: &str,
    limit: u8,
    domains: Option<&[String]>,
    cancel: &RequestCancellation,
) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
    validate_mcp_search(route, effect_id, challenge_id, lease_digest, query, limit, domains)?;
    if cancel.is_cancelled() {
        return Err(HttpExecutionErrorV1::Cancelled);
    }
    let addresses = resolve_public_addresses_cancellable(route, cancel)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    runtime.block_on(async_execute_mcp_search(
        route, &addresses, query, limit, domains, cancel,
    ))
}

fn validate_mcp_search(
    route: &HttpRoutePolicyV1,
    effect_id: &str,
    challenge_id: &str,
    lease_digest: &str,
    query: &str,
    limit: u8,
    domains: Option<&[String]>,
) -> Result<(), HttpExecutionErrorV1> {
    if fixed_web_search_mcp_route(&route.route_id).as_ref() != Some(route)
        || query.trim() != query
        || query.is_empty()
        || query.len() > 2_000
        || !(1..=10).contains(&limit)
        || !search_domain_filter_is_dispatchable(domains)
        || !valid_blake3(lease_digest)
        || effect_id.is_empty()
        || challenge_id.is_empty()
    {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    Ok(())
}

/// Execute the bounded three-request MCP lifecycle while preserving a narrowly
/// sourced proof when failure is known to precede its first HTTP request. Any
/// error after entering the initialize send is UNKNOWN because the provider may
/// have observed bytes, even if a later MCP frame failed.
pub(crate) fn execute_mcp_search_with_pre_send_proof(
    binding: &HttpExecutionBindingV1,
    route: &HttpRoutePolicyV1,
    sequence: u64,
    attempt: u8,
    query: &str,
    limit: u8,
    domains: Option<&[String]>,
    cancel: &RequestCancellation,
) -> HttpDispatchResultV1 {
    if sequence == 0
        || !(1..=2).contains(&attempt)
        || binding.route_id != route.route_id
        || binding.request_digest.is_empty()
        || !valid_blake3(&binding.request_digest)
        || !valid_blake3(&binding.capability_lease_digest)
    {
        return HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::InvalidRequest);
    }
    if let Err(error) = validate_mcp_search(
        route,
        &binding.effect_id,
        &binding.challenge_id,
        &binding.capability_lease_digest,
        query,
        limit,
        domains,
    ) {
        return HttpDispatchResultV1::Unknown(error);
    }

    // The only retryable proof window is before DNS completes and before the
    // first `mcp_post(...).send()` is entered. Do not infer zero-send from errors
    // returned by the MCP lifecycle itself.
    let pre_send_failure = if cancel.is_cancelled() {
        Some(HttpExecutionErrorV1::Cancelled)
    } else {
        match resolve_public_addresses_cancellable(route, cancel) {
            Ok(addresses) if addresses.iter().all(|address| address.port() == route.port) => {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => return HttpDispatchResultV1::NotDispatched {
                        proof: http_not_dispatched_proof(
                            binding, route, sequence, attempt,
                            HttpExecutionErrorV1::TransportFailure,
                        ),
                        failure: HttpExecutionErrorV1::TransportFailure,
                    },
                };
                return match runtime.block_on(async_execute_mcp_search(
                    route, &addresses, query, limit, domains, cancel,
                )) {
                    Ok(response) => HttpDispatchResultV1::Response(response),
                    Err(error) => HttpDispatchResultV1::Unknown(error),
                };
            }
            Ok(_) => Some(HttpExecutionErrorV1::AddressDenied),
            Err(error) => Some(error),
        }
    };
    let Some(failure) = pre_send_failure else {
        return HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::TransportFailure);
    };
    if !matches!(
        failure,
        HttpExecutionErrorV1::Cancelled
            | HttpExecutionErrorV1::TimedOut
            | HttpExecutionErrorV1::TransportFailure
    ) {
        return HttpDispatchResultV1::Unknown(failure);
    }
    HttpDispatchResultV1::NotDispatched {
        proof: http_not_dispatched_proof(binding, route, sequence, attempt, failure),
        failure,
    }
}

fn http_not_dispatched_proof(
    binding: &HttpExecutionBindingV1,
    route: &HttpRoutePolicyV1,
    sequence: u64,
    attempt: u8,
    failure: HttpExecutionErrorV1,
) -> HttpNotDispatchedProofV1 {
    HttpNotDispatchedProofV1 {
        execution_id: binding.execution_id.clone(),
        effect_id: binding.effect_id.clone(),
        challenge_id: binding.challenge_id.clone(),
        capability_lease_digest: binding.capability_lease_digest.clone(),
        attempt_scope_digest: binding.attempt_scope_digest.clone(),
        owner_epoch: binding.owner_epoch,
        generation: binding.generation,
        workspace_revision: binding.workspace_revision.clone(),
        request_digest: binding.request_digest.clone(),
        route_id: route.route_id.clone(),
        sequence,
        attempt,
        failure,
    }
}

async fn async_execute_mcp_search(
    route: &HttpRoutePolicyV1,
    addresses: &[SocketAddr],
    query: &str,
    limit: u8,
    domains: Option<&[String]>,
    cancel: &RequestCancellation,
) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
    let timeout = Duration::from_millis(route.timeout_ms.min(12_000));
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .timeout(timeout)
        .resolve_to_addrs(&route.host, addresses)
        .build()
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    let target = format!("https://{}{}", route.host, route.path_prefix);
    let started = Instant::now();
    let init = serde_json::json!({
        "jsonrpc":"2.0", "id":1, "method":"initialize",
        "params":{"protocolVersion":"2025-03-26","capabilities":{},
            "clientInfo":{"name":"HorizonCode","version":"1"}}
    });
    let (mut response, session_id, peer) = mcp_post(
        &client, &target, &init, None, route, &addresses, cancel, started,
    ).await?;
    if response.status() != reqwest::StatusCode::OK {
        return mcp_response(response, peer, route, cancel).await;
    }
    let session_id = session_id.ok_or(HttpExecutionErrorV1::TransportFailure)?;
    if session_id.is_empty() || session_id.len() > 256
        || session_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(HttpExecutionErrorV1::TransportFailure);
    }
    let init_content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
    let init_body = read_response_body(&mut response, route.max_response_bytes, cancel).await?;
    let init_json = decode_mcp_frame(&init_content_type, &init_body.bytes)?;
    let init_value: serde_json::Value = serde_json::from_slice(&init_json)
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    if init_body.truncated
        || init_value.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
        || init_value.get("id").and_then(serde_json::Value::as_u64) != Some(1)
        || init_value.get("result").is_none()
        || init_value.get("error").is_some()
        || init_value.pointer("/result/protocolVersion").and_then(serde_json::Value::as_str)
            != Some("2025-03-26")
    {
        return Err(HttpExecutionErrorV1::ResponseTooLarge);
    }
    let initialized = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"});
    let (mut notification, _, notification_peer) = mcp_post(
        &client, &target, &initialized, Some(&session_id), route, &addresses, cancel, started,
    ).await?;
    if notification.status() != reqwest::StatusCode::ACCEPTED
        && notification.status() != reqwest::StatusCode::OK
        && notification.status() != reqwest::StatusCode::NO_CONTENT
    {
        return mcp_response(notification, notification_peer, route, cancel).await;
    }
    if notification.status() == reqwest::StatusCode::OK {
        let content_type = notification.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
        let ignored = read_response_body(&mut notification, 4096, cancel).await?;
        let _ = decode_mcp_frame(&content_type, &ignored.bytes)?;
        if ignored.truncated { return Err(HttpExecutionErrorV1::ResponseTooLarge); }
    }
    if !search_domain_filter_is_dispatchable(domains) {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    let (name, mut arguments, mut params_meta) = match route.provider_id.as_str() {
        "exa" => ("web_search_exa", serde_json::json!({"query":query,"numResults":limit,
            "contents":{"text":{"maxCharacters":1200}}}), None),
        // You.com reserves include_domains for host-provided MCP metadata; putting
        // it in model arguments would expose a host policy knob to the model.
        "youcom" => ("you-search", serde_json::json!({"query":query,"count":limit,"safesearch":"moderate"}),
            None),
        "tavily" => ("tavily_search", serde_json::json!({"query":query,"max_results":limit,
            "search_depth":"basic"}), None),
        // These MCP search tools do not expose a stable host-only domain-filter
        // field. Apply the provider-supported site operator to the query rather
        // than inventing an unrecognized tools/call argument.
        "firecrawl" => ("firecrawl_search", serde_json::json!({"query":search_query_with_domains(query, domains),
            "limit":limit,"sources":["web"]}), None),
        "parallel" => ("web_search", serde_json::json!({"query":search_query_with_domains(query, domains),
            "max_results":limit}), None),
        _ => return Err(HttpExecutionErrorV1::RouteDenied),
    };
    if let Some(domains) = domains {
        match route.provider_id.as_str() {
            "exa" => arguments["includeDomains"] = serde_json::json!(domains),
            "youcom" => params_meta = Some(serde_json::json!({
                "com.you.com/search":{"include_domains":domains}
            })),
            "tavily" => arguments["include_domains"] = serde_json::json!(domains),
            "firecrawl" | "parallel" => {
                arguments["query"] = serde_json::Value::String(search_query_with_domains(query, Some(domains)));
            }
            _ => return Err(HttpExecutionErrorV1::RouteDenied),
        }
    }
    let mut params = serde_json::json!({"name":name,"arguments":arguments});
    if let Some(meta) = params_meta {
        params["_meta"] = meta;
    }
    let call = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":params});
    let (mut final_response, _, final_peer) = mcp_post(
        &client, &target, &call, Some(&session_id), route, &addresses, cancel, started,
    ).await?;
    if final_response.status().is_redirection() {
        return Err(HttpExecutionErrorV1::RedirectDenied);
    }
    let mut settled = mcp_response(final_response, final_peer, route, cancel).await?;
    let call_value: serde_json::Value = serde_json::from_slice(&settled.body)
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    if call_value.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
        || call_value.get("id").and_then(serde_json::Value::as_u64) != Some(2)
        || (call_value.get("result").is_none() && call_value.get("error").is_none())
    {
        return Err(HttpExecutionErrorV1::TransportFailure);
    }
    // The final MCP frame is the only response body returned to Core; initialization
    // and session identifiers never cross the transport boundary.
    settled.retry_after_header = None;
    Ok(settled)
}

async fn mcp_post(
    client: &reqwest::Client,
    target: &str,
    body: &serde_json::Value,
    session_id: Option<&str>,
    route: &HttpRoutePolicyV1,
    addresses: &[SocketAddr],
    cancel: &RequestCancellation,
    started: Instant,
) -> Result<(reqwest::Response, Option<String>, IpAddr), HttpExecutionErrorV1> {
    if cancel.is_cancelled() || started.elapsed() >= Duration::from_millis(30_000) {
        return Err(HttpExecutionErrorV1::OutcomeUnknown);
    }
    let mut request = client.post(target)
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(body);
    if let Some(session) = session_id { request = request.header("Mcp-Session-Id", session); }
    match route.provider_id.as_str() {
        "tavily" => { request = request.header("X-Tavily-Access-Mode", "keyless")
            .header("X-Client-Source", "tavily-mcp-keyless"); }
        _ => {}
    }
    let remaining = Duration::from_millis(30_000).saturating_sub(started.elapsed());
    if remaining.is_zero() { return Err(HttpExecutionErrorV1::OutcomeUnknown); }
    let response = await_cancellable(request.timeout(remaining.min(Duration::from_millis(route.timeout_ms))).send(), cancel, true).await?
        .map_err(|_| HttpExecutionErrorV1::OutcomeUnknown)?;
    if response.status().is_redirection() {
        return Err(HttpExecutionErrorV1::RedirectDenied);
    }
    let peer = response.remote_addr().ok_or(HttpExecutionErrorV1::AddressDenied)?;
    verify_connected_peer(addresses, peer)
        .map_err(|_| HttpExecutionErrorV1::AddressDenied)?;
    let session = response.headers().get("Mcp-Session-Id")
        .and_then(|value| value.to_str().ok()).map(str::to_owned);
    Ok((response, session, peer.ip()))
}

async fn mcp_response(
    mut response: reqwest::Response,
    peer: IpAddr,
    route: &HttpRoutePolicyV1,
    cancel: &RequestCancellation,
) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
    let status = response.status().as_u16();
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
    let retry_after_header = response.headers().get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok()).filter(|value| value.len() <= 128).map(str::to_owned);
    let retry_after_ms = retry_after_header.as_deref().and_then(parse_retry_after_ms);
    let capture = read_response_body(&mut response, route.max_response_bytes, cancel).await?;
    let body = if capture.truncated || !(200..300).contains(&status) { capture.bytes } else {
        decode_mcp_frame(&content_type, &capture.bytes)?
    };
    let body_digest = format!("blake3:{}", blake3::hash(&body).to_hex());
    Ok(HttpResponseV1 { status, retry_after_ms, retry_after_header, body,
        body_digest, body_truncated: capture.truncated, response_complete: !capture.truncated,
        connected_peer: Some(peer) })
}

fn decode_mcp_frame(content_type: &str, body: &[u8]) -> Result<Vec<u8>, HttpExecutionErrorV1> {
    if content_type.eq_ignore_ascii_case("application/json")
        || content_type.to_ascii_lowercase().starts_with("application/json;")
    {
        return Ok(body.to_vec());
    }
    if !content_type.eq_ignore_ascii_case("text/event-stream")
        && !content_type.to_ascii_lowercase().starts_with("text/event-stream;")
    {
        return Err(HttpExecutionErrorV1::TransportFailure);
    }
    let text = std::str::from_utf8(body).map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    let mut response = None;
    for line in text.lines() {
        if line.starts_with("event:") && line[6..].trim() == "endpoint" {
            return Err(HttpExecutionErrorV1::RouteDenied);
        }
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim_start();
        if data == "[DONE]" || data.is_empty() { continue; }
        let parsed: serde_json::Value = serde_json::from_str(data)
            .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
        if parsed.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
            return Err(HttpExecutionErrorV1::TransportFailure);
        }
        response = Some(data.as_bytes().to_vec());
    }
    response.ok_or(HttpExecutionErrorV1::TransportFailure)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRoutePolicyV1 {
    pub provider_id: String,
    pub route_id: String,
    pub host: String,
    pub port: u16,
    /// Public DNS answers resolved by the authenticated host after effect admission.
    /// The transport pins to these exact socket addresses and verifies its peer.
    pub resolved_addresses: Vec<SocketAddr>,
    pub path_prefix: String,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRequestV1 {
    pub effect_id: String,
    pub challenge_id: String,
    pub capability_lease_digest: String,
    pub route_id: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub max_response_bytes: usize,
    pub timeout_ms: u64,
    /// Opaque metadata only. This module rejects it until a trusted SecretBroker can
    /// resolve a request-bound one-use secret lease after Guard ALLOW.
    pub credential_ref: Option<String>,
}

impl HttpRequestV1 {
    pub fn keyless(
        effect_id: impl Into<String>,
        challenge_id: impl Into<String>,
        capability_lease_digest: impl Into<String>,
        route_id: impl Into<String>,
        target: impl Into<String>,
        body: Vec<u8>,
    ) -> Self {
        Self {
            effect_id: effect_id.into(),
            challenge_id: challenge_id.into(),
            capability_lease_digest: capability_lease_digest.into(),
            route_id: route_id.into(),
            target: target.into(),
            headers: Vec::new(),
            body,
            max_response_bytes: MAX_HTTP_RESPONSE_BYTES,
            timeout_ms: MAX_HTTP_TIMEOUT_MS,
            credential_ref: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpResponseV1 {
    pub status: u16,
    pub retry_after_ms: Option<u64>,
    pub retry_after_header: Option<String>,
    pub body: Vec<u8>,
    /// Digest covers exactly the bytes retained in `body`; when truncated the
    /// response is explicitly incomplete and this is not represented as a full-body
    /// digest.
    pub body_digest: String,
    pub body_truncated: bool,
    pub response_complete: bool,
    /// Present for Rust-owned socket transports. SecretBroker-mediated fixed
    /// provider requests intentionally have no Rust-observed peer address.
    pub connected_peer: Option<IpAddr>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpExecutionErrorV1 {
    InvalidRequest,
    RouteDenied,
    AddressDenied,
    CredentialsUnavailable,
    Cancelled,
    RedirectDenied,
    ResponseTooLarge,
    TimedOut,
    TransportFailure,
    OutcomeUnknown,
    ConcurrencyLimit,
}

/// Authenticated facts copied from the existing approved EffectHost challenge by
/// HostKernel. Request bodies never choose the principal, lease, scope or workspace.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionBindingV1 {
    pub execution_id: String,
    pub effect_id: String,
    pub challenge_id: String,
    pub principal: String,
    pub session_id: String,
    pub location_id: String,
    pub capability_id: String,
    pub capability_lease_digest: String,
    pub approved_arguments_digest: String,
    pub attempt_scope_digest: Option<String>,
    pub owner_epoch: u64,
    pub generation: u64,
    pub workspace_revision: String,
    pub route_id: String,
    pub request_digest: String,
}

/// Proof that a fixed-route transport failed before handing any request bytes to
/// the HTTP client. It is minted only by the pre-send route resolver below and is
/// tied to the one durable route-attempt row; callers cannot supply byte counts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HttpNotDispatchedProofV1 {
    execution_id: String,
    effect_id: String,
    challenge_id: String,
    capability_lease_digest: String,
    attempt_scope_digest: Option<String>,
    owner_epoch: u64,
    generation: u64,
    workspace_revision: String,
    request_digest: String,
    route_id: String,
    sequence: u64,
    attempt: u8,
    failure: HttpExecutionErrorV1,
}

impl HttpNotDispatchedProofV1 {
    pub(crate) fn execution_id(&self) -> &str { &self.execution_id }
    pub(crate) fn effect_id(&self) -> &str { &self.effect_id }
    pub(crate) fn challenge_id(&self) -> &str { &self.challenge_id }
    pub(crate) fn request_digest(&self) -> &str { &self.request_digest }
    pub(crate) fn route_id(&self) -> &str { &self.route_id }
    pub(crate) fn sequence(&self) -> u64 { self.sequence }
    pub(crate) fn attempt(&self) -> u8 { self.attempt }
    pub(crate) fn failure(&self) -> HttpExecutionErrorV1 { self.failure }
    pub(crate) fn failure_code(&self) -> &'static str {
        match self.failure {
            HttpExecutionErrorV1::Cancelled => "cancelled",
            HttpExecutionErrorV1::TimedOut => "timed_out",
            HttpExecutionErrorV1::TransportFailure => "transport_failure",
            _ => "unretryable",
        }
    }

    pub(crate) fn retryable(&self) -> bool {
        matches!(self.failure, HttpExecutionErrorV1::TimedOut | HttpExecutionErrorV1::TransportFailure)
    }

    pub(crate) fn matches_binding(&self, binding: &HttpExecutionBindingV1) -> bool {
        self.execution_id == binding.execution_id
            && self.effect_id == binding.effect_id
            && self.challenge_id == binding.challenge_id
            && self.capability_lease_digest == binding.capability_lease_digest
            && self.attempt_scope_digest == binding.attempt_scope_digest
            && self.owner_epoch == binding.owner_epoch
            && self.generation == binding.generation
            && self.workspace_revision == binding.workspace_revision
            && self.request_digest == binding.request_digest
    }

    pub(crate) fn receipt_digest(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.http.not-dispatched.v1\0");
        for field in [
            self.execution_id.as_str(), self.effect_id.as_str(), self.challenge_id.as_str(),
            self.capability_lease_digest.as_str(), self.attempt_scope_digest.as_deref().unwrap_or(""),
            self.workspace_revision.as_str(), self.request_digest.as_str(), self.route_id.as_str(),
        ] {
            hasher.update(&(field.len() as u64).to_be_bytes());
            hasher.update(field.as_bytes());
        }
        hasher.update(&self.owner_epoch.to_be_bytes());
        hasher.update(&self.generation.to_be_bytes());
        hasher.update(&self.sequence.to_be_bytes());
        hasher.update(&[self.attempt]);
        let failure = self.failure_code();
        hasher.update(&(failure.len() as u64).to_be_bytes());
        hasher.update(failure.as_bytes());
        format!("blake3:{}", hasher.finalize().to_hex())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HttpDispatchResultV1 {
    Response(HttpResponseV1),
    NotDispatched { proof: HttpNotDispatchedProofV1, failure: HttpExecutionErrorV1 },
    Unknown(HttpExecutionErrorV1),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionPreparedV1 {
    pub execution_id: String,
    pub generation: u64,
    pub execution_digest: String,
    pub approved_arguments_digest: String,
    pub capability_lease_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpExecutionStateV1 {
    Prepared,
    Running,
    Settled,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionStatusV1 {
    pub execution_id: String,
    pub generation: u64,
    pub state: HttpExecutionStateV1,
    /// Present when an admitted route plan terminates without selecting a single
    /// response as the aggregate result. Route receipts remain available separately.
    /// Values are CANCELLED, FAILED or EXHAUSTED.
    pub outcome: Option<String>,
    /// Present for terminal no-response recovery and commits the full approved order,
    /// including routes not reached before cancellation.
    pub route_plan_digest: Option<String>,
    pub http_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub body_digest: Option<String>,
    pub body_bytes: u64,
    pub body_truncated: bool,
    pub connected_peer: Option<IpAddr>,
    pub receipt_digest: Option<String>,
}

/// Aggregate receipt for an admitted route plan terminated without selecting an
/// aggregate HTTP response. The ordered route history remains in EffectHost.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HttpExecutionTerminalReceiptV1 {
    pub(crate) execution_id: String,
    pub(crate) effect_id: String,
    pub(crate) generation: u64,
    pub(crate) outcome: String,
    pub(crate) route_plan_digest: String,
    pub(crate) receipt_digest: String,
}

/// HostKernel's retained copy of one exact durable route subreceipt. EffectHost
/// compares this ordered list to its journal before terminal aggregate settlement;
/// it is never decoded from an RPC request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HttpRouteReceiptRefV1 {
    pub(crate) sequence: u64,
    pub(crate) route_id: String,
    pub(crate) attempt: u8,
    pub(crate) outcome: String,
    pub(crate) not_dispatched_failure: Option<String>,
    pub(crate) receipt_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionReceiptV1 {
    pub execution_id: String,
    pub effect_id: String,
    pub generation: u64,
    pub route_id: String,
    pub http_status: u16,
    pub retry_after_ms: Option<u64>,
    pub body_digest: String,
    pub body_bytes: u64,
    pub body_truncated: bool,
    pub connected_peer: Option<IpAddr>,
    /// Present only for aggregate success settlement against an approved route
    /// plan. Direct single-route responses have no route-plan authority.
    pub route_plan_digest: Option<String>,
    pub receipt_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionRecoveryV1 {
    pub binding: HttpExecutionBindingV1,
    pub status: HttpExecutionStatusV1,
}

/// Sanitized durable subreceipt for one fixed route attempt in a Guarded cascade.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRouteAttemptRecoveryV1 {
    pub sequence: u64,
    pub route_id: String,
    pub attempt: u8,
    pub state: String,
    pub outcome: Option<String>,
    /// Host-observed bounded pre-send failure class. Present only for a
    /// NOT_DISPATCHED receipt; only timeout/transport failure may authorize retry.
    pub not_dispatched_failure: Option<String>,
    pub result_count: Option<usize>,
    pub http_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub body_digest: Option<String>,
    pub body_bytes: u64,
    pub body_truncated: bool,
    pub receipt_digest: Option<String>,
}

/// Internal token minted only after the approved challenge and HTTP dispatch intent are
/// committed atomically. It cannot be reconstructed from request fields.
#[derive(Clone, Debug)]
pub struct HttpExecutionDispatchIntentV1 {
    binding: HttpExecutionBindingV1,
    execution_digest: String,
    intent_id: String,
}

impl HttpExecutionDispatchIntentV1 {
    pub(crate) fn new(
        binding: HttpExecutionBindingV1,
        execution_digest: String,
        intent_id: String,
    ) -> Self {
        Self {
            binding,
            execution_digest,
            intent_id,
        }
    }

    pub(crate) fn binding(&self) -> &HttpExecutionBindingV1 {
        &self.binding
    }

    pub(crate) fn execution_digest(&self) -> &str {
        &self.execution_digest
    }

    pub(crate) fn intent_id(&self) -> &str {
        &self.intent_id
    }
}

pub fn validate_request_target(
    route: &HttpRoutePolicyV1,
    target: &str,
) -> Result<(), HttpExecutionErrorV1> {
    if route.port != 443 || !valid_host(&route.host) || !route.path_prefix.starts_with('/') {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    let Some(rest) = target.strip_prefix("https://") else {
        return Err(HttpExecutionErrorV1::RouteDenied);
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let target_host = authority.strip_suffix(":443").unwrap_or(authority);
    if target_host.contains(':')
        || target_host.contains('@')
        || !target_host.eq_ignore_ascii_case(&route.host)
        || authority.ends_with(':')
    {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    let path_and_query = if authority_end == rest.len() {
        "/"
    } else if rest[authority_end..].starts_with('?') {
        // A query without a path still targets the route's root, which must be in scope.
        return Err(HttpExecutionErrorV1::RouteDenied);
    } else {
        &rest[authority_end..]
    };
    if path_and_query.contains('#')
        || path_and_query.contains('\\')
        || path_and_query
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f)
    {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    let path = path_and_query.split('?').next().unwrap_or_default();
    let Some(path_suffix) = path.strip_prefix(&route.path_prefix) else {
        return Err(HttpExecutionErrorV1::RouteDenied);
    };
    if !(path_suffix.is_empty() || path_suffix.starts_with('/'))
        || path.to_ascii_lowercase().contains("%2e")
        || path.to_ascii_lowercase().contains("%2f")
        || path.to_ascii_lowercase().contains("%5c")
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    Ok(())
}

pub fn validate_limits(
    route: &HttpRoutePolicyV1,
    request_bytes: usize,
    response_bytes: usize,
    timeout_ms: u64,
) -> Result<(), HttpExecutionErrorV1> {
    if route.max_request_bytes == 0
        || route.max_request_bytes > MAX_HTTP_REQUEST_BYTES
        || route.max_response_bytes == 0
        || route.max_response_bytes > MAX_HTTP_RESPONSE_BYTES
        || route.timeout_ms == 0
        || route.timeout_ms > MAX_HTTP_TIMEOUT_MS
        || request_bytes == 0
        || request_bytes > route.max_request_bytes
        || response_bytes == 0
        || response_bytes > route.max_response_bytes
        || timeout_ms == 0
        || timeout_ms > route.timeout_ms
    {
        return Err(HttpExecutionErrorV1::InvalidRequest);
    }
    Ok(())
}

pub fn validate_request(
    route: &HttpRoutePolicyV1,
    request: &HttpRequestV1,
) -> Result<(), HttpExecutionErrorV1> {
    if request.credential_ref.is_some() {
        return Err(HttpExecutionErrorV1::CredentialsUnavailable);
    }
    if request.headers.iter().any(|(name, _)| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
        )
    }) {
        return Err(HttpExecutionErrorV1::CredentialsUnavailable);
    }
    if request.headers.iter().any(|(name, value)| {
        !name.eq_ignore_ascii_case("content-type")
            || !value.eq_ignore_ascii_case("application/json")
    }) {
        return Err(HttpExecutionErrorV1::InvalidRequest);
    }
    if request.effect_id.is_empty()
        || request.challenge_id.is_empty()
        || request.route_id != route.route_id
        || !valid_blake3(&request.capability_lease_digest)
    {
        return Err(HttpExecutionErrorV1::InvalidRequest);
    }
    if serde_json::from_slice::<serde_json::Value>(&request.body).is_err() {
        return Err(HttpExecutionErrorV1::InvalidRequest);
    }
    validate_request_target(route, &request.target)?;
    if route.provider_id == "brave" {
        let (query, limit) = canonical_search_input(&request.body)?;
        if fixed_brave_search_target(query, limit).as_deref() != Some(request.target.as_str()) {
            return Err(HttpExecutionErrorV1::RouteDenied);
        }
    } else if fixed_web_search_route(&route.route_id).as_ref() == Some(route) {
        let _ = canonical_search_input(&request.body)?;
    }
    validate_limits(
        route,
        request.body.len(),
        request.max_response_bytes,
        request.timeout_ms,
    )
}

pub fn is_public_unicast(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            (segments[0] & 0xe000) == 0x2000
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001
                    && (segments[1] == 0
                        || segments[1] == 0x0002
                        || segments[1] == 0x0db8
                        || (segments[1] & 0xfff0 == 0x0010)
                        || (segments[1] & 0xfff0 == 0x0020)))
        }
    }
}

/// Resolve the exact allowlisted host once and pin the transport to every result.
/// A mixed public/private answer is rejected rather than selecting only the public
/// address, so DNS rebinding cannot race a later transport resolution.
pub fn resolve_public_addresses(
    route: &HttpRoutePolicyV1,
) -> Result<Vec<SocketAddr>, HttpExecutionErrorV1> {
    if route.port != 443 || !valid_host(&route.host) {
        return Err(HttpExecutionErrorV1::RouteDenied);
    }
    let addresses = (route.host.as_str(), route.port)
        .to_socket_addrs()
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?
        .take(MAX_HTTP_DNS_ADDRESSES + 1)
        .collect::<Vec<_>>();
    validate_resolved_addresses(&addresses)?;
    if addresses.iter().any(|address| address.port() != route.port) {
        return Err(HttpExecutionErrorV1::AddressDenied);
    }
    Ok(addresses)
}

/// Resolve under a finite wait and small global resolver-thread limit. The operating
/// system resolver API is blocking and cannot be interrupted portably; on cancellation
/// or timeout its bounded worker is detached, its result discarded, and its slot remains
/// occupied until the OS call returns. This prevents a stuck resolver from spawning an
/// unbounded set of detached threads.
pub fn resolve_public_addresses_cancellable(
    route: &HttpRoutePolicyV1,
    cancel: &RequestCancellation,
) -> Result<Vec<SocketAddr>, HttpExecutionErrorV1> {
    static ACTIVE_RESOLVERS: AtomicUsize = AtomicUsize::new(0);
    let mut active = ACTIVE_RESOLVERS.load(Ordering::Acquire);
    loop {
        if active >= MAX_HTTP_CONCURRENT_REQUESTS {
            return Err(HttpExecutionErrorV1::ConcurrencyLimit);
        }
        match ACTIVE_RESOLVERS.compare_exchange_weak(
            active,
            active + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => break,
            Err(actual) => active = actual,
        }
    }
    let route = route.clone();
    let (send, receive) = mpsc::sync_channel(1);
    if thread::Builder::new()
        .name("hz-http-dns".into())
        .spawn(move || {
            let _permit = DnsResolverPermit(&ACTIVE_RESOLVERS);
            let _ = send.send(resolve_public_addresses(&route));
        })
        .is_err()
    {
        ACTIVE_RESOLVERS.fetch_sub(1, Ordering::AcqRel);
        return Err(HttpExecutionErrorV1::TransportFailure);
    }
    let deadline = Instant::now() + MAX_HTTP_DNS_TIME;
    loop {
        if cancel.is_cancelled() {
            return Err(HttpExecutionErrorV1::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HttpExecutionErrorV1::TimedOut);
        }
        match receive.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(HttpExecutionErrorV1::TransportFailure);
            }
        }
    }
}

struct DnsResolverPermit(&'static AtomicUsize);

impl Drop for DnsResolverPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), HttpExecutionErrorV1> {
    if addresses.is_empty()
        || addresses.len() > MAX_HTTP_DNS_ADDRESSES
        || addresses
            .iter()
            .any(|address| !is_public_unicast(address.ip()))
    {
        return Err(HttpExecutionErrorV1::AddressDenied);
    }
    Ok(())
}

pub fn verify_connected_peer(
    expected: &[SocketAddr],
    connected_peer: SocketAddr,
) -> Result<(), HttpExecutionErrorV1> {
    if expected.iter().any(|address| address == &connected_peer) {
        Ok(())
    } else {
        Err(HttpExecutionErrorV1::AddressDenied)
    }
}

pub fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<u64>().ok()?;
    Some(seconds.saturating_mul(1_000).min(MAX_RETRY_AFTER_MS))
}

/// Send one already Guard-authorized keyless request over a direct, pinned HTTPS
/// connection. This function performs no retries and never follows redirects. The
/// caller must durably spend its one-use Guard lease before calling it and persist the
/// returned receipt or UNKNOWN outcome afterward.
pub fn execute_pinned(
    route: &HttpRoutePolicyV1,
    request: &HttpRequestV1,
    cancel: &RequestCancellation,
) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
    validate_request(route, request)?;
    if cancel.is_cancelled() {
        return Err(HttpExecutionErrorV1::Cancelled);
    }
    let addresses = resolve_public_addresses_cancellable(route, cancel)?;
    if addresses.iter().any(|address| address.port() != route.port) {
        return Err(HttpExecutionErrorV1::AddressDenied);
    }
    let timeout = Duration::from_millis(request.timeout_ms);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|_| HttpExecutionErrorV1::TransportFailure)?;
    runtime.block_on(async_execute_pinned(
        route, request, cancel, &addresses, timeout,
    ))
}

/// Execute one already-authorized fixed route while exposing only a narrowly
/// sourced zero-send proof. Validation/address failures before client dispatch may
/// produce `NotDispatched`; once `send()` is entered every error is UNKNOWN.
pub(crate) fn execute_pinned_with_pre_send_proof(
    binding: &HttpExecutionBindingV1,
    route: &HttpRoutePolicyV1,
    request: &HttpRequestV1,
    sequence: u64,
    attempt: u8,
    cancel: &RequestCancellation,
) -> HttpDispatchResultV1 {
    if sequence == 0 || !(1..=2).contains(&attempt)
        || request.route_id != route.route_id
        || request.effect_id != binding.effect_id
        || request.challenge_id != binding.challenge_id
        || request.capability_lease_digest != binding.capability_lease_digest
        || !valid_blake3(&binding.capability_lease_digest)
        || !valid_blake3(&binding.request_digest)
    {
        return HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::InvalidRequest);
    }
    if let Err(error) = validate_request(route, request) {
        return HttpDispatchResultV1::Unknown(error);
    }
    let no_send_failure = if cancel.is_cancelled() {
        Some(HttpExecutionErrorV1::Cancelled)
    } else {
        match resolve_public_addresses_cancellable(route, cancel) {
            Ok(addresses) if addresses.iter().all(|address| address.port() == route.port) => {
                let timeout = Duration::from_millis(request.timeout_ms);
                match tokio::runtime::Builder::new_current_thread().enable_time().build() {
                    Ok(runtime) => {
                        return match runtime.block_on(async_execute_pinned(
                            route, request, cancel, &addresses, timeout,
                        )) {
                            Ok(response) => HttpDispatchResultV1::Response(response),
                            Err(HttpExecutionErrorV1::OutcomeUnknown) =>
                                HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::OutcomeUnknown),
                            Err(error) => HttpDispatchResultV1::Unknown(error),
                        };
                    }
                    Err(_) => Some(HttpExecutionErrorV1::TransportFailure),
                }
            }
            Ok(_) => Some(HttpExecutionErrorV1::AddressDenied),
            Err(error) => Some(error),
        }
    };
    let Some(failure) = no_send_failure else {
        return HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::TransportFailure);
    };
    if !matches!(failure,
        HttpExecutionErrorV1::Cancelled | HttpExecutionErrorV1::TimedOut
            | HttpExecutionErrorV1::TransportFailure
    ) {
        return HttpDispatchResultV1::Unknown(failure);
    }
    HttpDispatchResultV1::NotDispatched {
        proof: HttpNotDispatchedProofV1 {
            execution_id: binding.execution_id.clone(),
            effect_id: binding.effect_id.clone(),
            challenge_id: binding.challenge_id.clone(),
            capability_lease_digest: binding.capability_lease_digest.clone(),
            attempt_scope_digest: binding.attempt_scope_digest.clone(),
            owner_epoch: binding.owner_epoch,
            generation: binding.generation,
            workspace_revision: binding.workspace_revision.clone(),
            request_digest: binding.request_digest.clone(),
            route_id: route.route_id.clone(),
            sequence,
            attempt,
            failure,
        },
        failure,
    }
}

async fn async_execute_pinned(
    route: &HttpRoutePolicyV1,
    request: &HttpRequestV1,
    cancel: &RequestCancellation,
    addresses: &[SocketAddr],
    timeout: Duration,
) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .timeout(timeout)
        .resolve_to_addrs(&route.host, addresses)
        .build()
        .map_err(|error| {
            if error.is_timeout() {
                HttpExecutionErrorV1::TimedOut
            } else {
                HttpExecutionErrorV1::TransportFailure
            }
        })?;
    let outbound = if route.provider_id == "brave" {
        client.get(&request.target).header(reqwest::header::ACCEPT, "application/json")
    } else {
        let body = provider_search_body(&route.provider_id, &request.body)?;
        client.post(&request.target)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
    };
    let mut response = await_cancellable(
        outbound.send(),
        cancel,
        true,
    )
    .await?
    .map_err(|error| {
        let _ = error;
        HttpExecutionErrorV1::OutcomeUnknown
    })?;
    if cancel.is_cancelled() {
        return Err(HttpExecutionErrorV1::OutcomeUnknown);
    }
    let peer = response
        .remote_addr()
        .ok_or(HttpExecutionErrorV1::AddressDenied)?;
    verify_connected_peer(&addresses, peer).map_err(|_| HttpExecutionErrorV1::AddressDenied)?;
    if response.status().is_redirection() {
        return Err(HttpExecutionErrorV1::RedirectDenied);
    }
    let status = response.status().as_u16();
    let retry_after_ms = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|header| header.to_str().ok())
        .and_then(parse_retry_after_ms);
    let retry_after_header = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|header| header.to_str().ok())
        .filter(|value| value.len() <= 128)
        .map(str::to_owned);
    let known_too_large = response
        .content_length()
        .is_some_and(|length| length > request.max_response_bytes as u64);
    let capture = if known_too_large {
        BoundedHttpBody {
            bytes: Vec::new(),
            truncated: true,
        }
    } else {
        read_response_body(&mut response, request.max_response_bytes, cancel).await?
    };
    if cancel.is_cancelled() {
        return Err(HttpExecutionErrorV1::OutcomeUnknown);
    }
    let body = capture.bytes;
    let body_truncated = capture.truncated;
    let body_digest = format!("blake3:{}", blake3::hash(&body).to_hex());
    Ok(HttpResponseV1 {
        status,
        retry_after_ms,
        retry_after_header,
        body,
        body_digest,
        body_truncated,
        response_complete: !body_truncated,
        connected_peer: Some(peer.ip()),
    })
}

fn canonical_search_input(body: &[u8]) -> Result<(&str, u8), HttpExecutionErrorV1> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| HttpExecutionErrorV1::InvalidRequest)?;
    let object = value.as_object().ok_or(HttpExecutionErrorV1::InvalidRequest)?;
    if object.len() != 2 { return Err(HttpExecutionErrorV1::InvalidRequest); }
    let query = object.get("query").and_then(serde_json::Value::as_str)
        .filter(|query| !query.is_empty() && query.trim() == *query && query.len() <= 2_000)
        .ok_or(HttpExecutionErrorV1::InvalidRequest)?;
    let limit = object.get("limit").and_then(serde_json::Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=10).contains(value))
        .ok_or(HttpExecutionErrorV1::InvalidRequest)?;
    Ok((query, limit))
}

fn provider_search_body(provider: &str, canonical: &[u8]) -> Result<Vec<u8>, HttpExecutionErrorV1> {
    let (query, limit) = canonical_search_input(canonical)?;
    let value = match provider {
        "exa" => serde_json::json!({"query":query,"numResults":limit,
            "contents":{"text":{"maxCharacters":1200}}}),
        "youcom" => serde_json::json!({"query":query,"count":limit}),
        "tavily" => serde_json::json!({"query":query,"search_depth":"basic","max_results":limit,
            "include_answer":false,"include_raw_content":false}),
        "firecrawl" => serde_json::json!({"query":query,"limit":limit,"sources":["web"],
            "safe":true,"highlights":true}),
        "parallel" => serde_json::json!({"objective":query,"search_queries":[query],
            "mode":"fast","max_chars_total":12000}),
        _ => return Err(HttpExecutionErrorV1::RouteDenied),
    };
    serde_json::to_vec(&value).map_err(|_| HttpExecutionErrorV1::InvalidRequest)
}

#[derive(Debug, Eq, PartialEq)]
struct BoundedHttpBody {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_response_body(
    response: &mut reqwest::Response,
    max_bytes: usize,
    cancel: &RequestCancellation,
) -> Result<BoundedHttpBody, HttpExecutionErrorV1> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    loop {
        if cancel.is_cancelled() {
            return Err(HttpExecutionErrorV1::OutcomeUnknown);
        }
        let next = await_cancellable(response.chunk(), cancel, true)
            .await?
            .map_err(|_| HttpExecutionErrorV1::OutcomeUnknown)?;
        let Some(chunk) = next else {
            return Ok(BoundedHttpBody {
                bytes,
                truncated: false,
            });
        };
        let remaining = max_bytes.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            return Ok(BoundedHttpBody {
                bytes,
                truncated: true,
            });
        }
    }
}

async fn await_cancellable<F: Future>(
    future: F,
    cancel: &RequestCancellation,
    after_dispatch: bool,
) -> Result<F::Output, HttpExecutionErrorV1> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            output = &mut future => return Ok(output),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {
                if cancel.is_cancelled() {
                    return Err(if after_dispatch {
                        HttpExecutionErrorV1::OutcomeUnknown
                    } else {
                        HttpExecutionErrorV1::Cancelled
                    });
                }
            }
        }
    }
}

async fn read_bounded_http_body<F, Fut, E>(
    mut next_chunk: F,
    max_bytes: usize,
    cancel: &RequestCancellation,
) -> Result<BoundedHttpBody, HttpExecutionErrorV1>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Option<Vec<u8>>, E>>,
{
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    loop {
        if cancel.is_cancelled() {
            return Err(HttpExecutionErrorV1::OutcomeUnknown);
        }
        let chunk = await_cancellable(next_chunk(), cancel, true)
            .await?
            .map_err(|_| HttpExecutionErrorV1::OutcomeUnknown)?;
        let Some(chunk) = chunk else {
            return Ok(BoundedHttpBody {
                bytes,
                truncated: false,
            });
        };
        let remaining = max_bytes.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            return Ok(BoundedHttpBody {
                bytes,
                truncated: true,
            });
        }
    }
}

/// Per-host HTTP transport gate. HostKernel remains the durable effect owner; this gate
/// only enforces a small process-local concurrency ceiling around a call already admitted
/// by Guard and the durable intent transaction.
#[derive(Clone, Default)]
pub struct HttpExecutionSupervisor {
    active: Arc<AtomicUsize>,
}

impl HttpExecutionSupervisor {
    pub fn active_count(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }

    pub fn execute(
        &self,
        route: &HttpRoutePolicyV1,
        request: &HttpRequestV1,
        cancel: &RequestCancellation,
    ) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= MAX_HTTP_CONCURRENT_REQUESTS {
                return Err(HttpExecutionErrorV1::ConcurrencyLimit);
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => active = actual,
            }
        }
        let _permit = HttpExecutionPermit(self.active.clone());
        execute_pinned(route, request, cancel)
    }

    /// Keep the complete three-frame MCP lifecycle under one process-wide
    /// concurrency permit; subrequests cannot multiply the configured bound.
    pub fn execute_mcp_search(
        &self,
        route: &HttpRoutePolicyV1,
        effect_id: &str,
        challenge_id: &str,
        lease_digest: &str,
        query: &str,
        limit: u8,
        domains: Option<&[String]>,
        cancel: &RequestCancellation,
    ) -> Result<HttpResponseV1, HttpExecutionErrorV1> {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= MAX_HTTP_CONCURRENT_REQUESTS {
                return Err(HttpExecutionErrorV1::ConcurrencyLimit);
            }
            match self.active.compare_exchange_weak(
                active, active + 1, Ordering::AcqRel, Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => active = actual,
            }
        }
        let _permit = HttpExecutionPermit(self.active.clone());
        execute_mcp_search_pinned(
            route, effect_id, challenge_id, lease_digest, query, limit, domains, cancel,
        )
    }

    /// Keep the proof-aware complete MCP lifecycle under the same process-wide
    /// concurrency permit as ordinary search calls. A saturated local queue is
    /// not represented as a provider retry proof.
    pub(crate) fn execute_mcp_search_with_pre_send_proof(
        &self,
        binding: &HttpExecutionBindingV1,
        route: &HttpRoutePolicyV1,
        sequence: u64,
        attempt: u8,
        query: &str,
        limit: u8,
        domains: Option<&[String]>,
        cancel: &RequestCancellation,
    ) -> HttpDispatchResultV1 {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= MAX_HTTP_CONCURRENT_REQUESTS {
                return HttpDispatchResultV1::Unknown(HttpExecutionErrorV1::ConcurrencyLimit);
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => active = actual,
            }
        }
        let _permit = HttpExecutionPermit(self.active.clone());
        execute_mcp_search_with_pre_send_proof(
            binding, route, sequence, attempt, query, limit, domains, cancel,
        )
    }
}

struct HttpExecutionPermit(Arc<AtomicUsize>);

impl Drop for HttpExecutionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.is_ascii()
        && value == value.to_ascii_lowercase()
        && !value.ends_with('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn valid_blake3(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    fn route() -> HttpRoutePolicyV1 {
        HttpRoutePolicyV1 {
            provider_id: "search-default".into(),
            route_id: "default.search".into(),
            host: "search.example.test".into(),
            port: 443,
            resolved_addresses: vec![SocketAddr::from(([8, 8, 8, 8], 443))],
            path_prefix: "/v1/search".into(),
            max_request_bytes: 8 * 1024,
            max_response_bytes: 64 * 1024,
            timeout_ms: 5_000,
        }
    }

    #[test]
    fn search_domain_filters_are_bounded_strict_and_distinguish_absence() {
        assert!(valid_search_domains(None));
        assert!(valid_search_domains(Some(&[])));
        assert!(search_domain_filter_is_dispatchable(None));
        assert!(!search_domain_filter_is_dispatchable(Some(&[])));
        assert!(valid_search_domains(Some(&["example.com".to_owned(), "*.docs.example.com".to_owned()])));
        for invalid in ["", ".example.com", "example.com.", "-bad.example", "bad-.example",
            "exa_mple.com", "https://example.com", "*.", "éxample.com"] {
            assert!(!valid_search_domains(Some(&[invalid.to_owned()])), "accepted {invalid}");
        }
        let duplicate = vec!["example.com".to_owned(), "example.com".to_owned()];
        assert!(!valid_search_domains(Some(&duplicate)));
        let oversized = vec!["example.com".to_owned(); 101];
        assert!(!valid_search_domains(Some(&oversized)));
    }

    #[test]
    fn empty_search_allowlist_is_denied_before_dns_or_transport() {
        let registry = crate::request_cancellation::RequestCancellationRegistry::new(
            std::num::NonZeroUsize::new(1).unwrap(),
        );
        let active = registry.register("empty-search-domains").unwrap();
        let empty: Vec<String> = Vec::new();
        assert_eq!(execute_mcp_search_pinned(
            &HttpRoutePolicyV1 {
                provider_id: "exa".to_owned(),
                route_id: "web.search.exa_keyless".to_owned(),
                host: "mcp.exa.ai".to_owned(), port: 443, resolved_addresses: Vec::new(),
                path_prefix: "/mcp".to_owned(), max_request_bytes: MAX_HTTP_REQUEST_BYTES,
                max_response_bytes: MAX_HTTP_RESPONSE_BYTES, timeout_ms: 12_000,
            }, "effect", "challenge",
            "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "query", 5, Some(&empty), &active.cancellation()),
            Err(HttpExecutionErrorV1::RouteDenied));
    }

    #[test]
    fn fallback_search_query_adds_only_validated_domain_constraints() {
        assert_eq!(search_query_with_domains("hello world", None), "hello world");
        let domains = vec!["example.com".to_owned(), "*.docs.example.com".to_owned()];
        assert_eq!(search_query_with_domains("hello world", Some(&domains)),
            "(hello world) (site:example.com OR site:*.docs.example.com)");
    }

    #[test]
    fn destination_must_match_trusted_https_route_and_path() {
        let route = route();
        assert!(
            validate_request_target(&route, "https://search.example.test/v1/search?q=hello")
                .is_ok()
        );
        for target in [
            "http://search.example.test/v1/search?q=hello",
            "https://other.example.test/v1/search?q=hello",
            "https://search.example.test:444/v1/search?q=hello",
            "https://user@search.example.test/v1/search?q=hello",
            "https://search.example.test/v1/other?q=hello",
            "https://search.example.test/v1/search#fragment",
            "https://search.example.test/v1/search\\..\\admin",
            "https://search.example.test/v1/searchx?q=hello",
            "https://search.example.test/v1/search/%2e%2e/admin",
        ] {
            assert!(
                validate_request_target(&route, target).is_err(),
                "accepted {target}"
            );
        }
    }

    #[test]
    fn request_and_response_bounds_are_checked_before_transport() {
        let route = route();
        assert!(validate_limits(&route, 8 * 1024, 64 * 1024, 5_000).is_ok());
        assert!(validate_limits(&route, 8 * 1024 + 1, 64 * 1024, 5_000).is_err());
        assert!(validate_limits(&route, 8 * 1024, 64 * 1024 + 1, 5_000).is_err());
        assert!(validate_limits(&route, 8 * 1024, 64 * 1024, 5_001).is_err());
        assert!(validate_limits(&route, 0, 64 * 1024, 5_000).is_err());
    }

    #[test]
    fn bounded_response_capture_distinguishes_complete_from_truncated_bytes() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let registry = crate::request_cancellation::RequestCancellationRegistry::new(
            std::num::NonZeroUsize::new(1).unwrap(),
        );
        let active = registry.register("bounded-body").unwrap();
        let mut chunks = std::collections::VecDeque::from([b"12".to_vec(), b"34".to_vec()]);
        let complete = runtime
            .block_on(read_bounded_http_body(
                || {
                    let next = chunks.pop_front();
                    async move { Ok::<_, ()>(next) }
                },
                4,
                &active.cancellation(),
            ))
            .unwrap();
        assert_eq!(complete.bytes, b"1234");
        assert!(!complete.truncated);

        let mut chunks = std::collections::VecDeque::from([b"12345".to_vec()]);
        let oversized = runtime
            .block_on(read_bounded_http_body(
                || {
                    let next = chunks.pop_front();
                    async move { Ok::<_, ()>(next) }
                },
                4,
                &active.cancellation(),
            ))
            .unwrap();
        assert_eq!(oversized.bytes, b"1234");
        assert!(oversized.truncated);
    }

    #[test]
    fn cancellation_during_connect_drops_the_in_flight_transport_future() {
        use std::sync::atomic::AtomicBool;
        use std::time::Duration;

        struct DropProbe(Arc<AtomicBool>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let registry = crate::request_cancellation::RequestCancellationRegistry::new(
            std::num::NonZeroUsize::new(1).unwrap(),
        );
        let active = registry.register("cancel-connect").unwrap();
        let cancellation = active.cancellation();
        let probe = Arc::new(AtomicBool::new(false));
        let probe_in_future = probe.clone();
        let cancel_registry = registry.clone();
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            cancel_registry.cancel_request("cancel-connect").unwrap();
        });

        let result = runtime.block_on(await_cancellable(
            async move {
                let _drop_probe = DropProbe(probe_in_future);
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok::<_, ()>(())
            },
            &cancellation,
            true,
        ));
        cancel_thread.join().unwrap();
        assert_eq!(result, Err(HttpExecutionErrorV1::OutcomeUnknown));
        assert!(
            probe.load(Ordering::Acquire),
            "cancel must drop the in-flight request"
        );
    }

    #[test]
    fn cancellation_during_response_body_read_is_unknown_and_stops_reading() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let registry = crate::request_cancellation::RequestCancellationRegistry::new(
            std::num::NonZeroUsize::new(1).unwrap(),
        );
        let active = registry.register("cancel-body").unwrap();
        let cancellation = active.cancellation();
        let mut reads = 0;
        let result = runtime.block_on(read_bounded_http_body(
            || {
                reads += 1;
                let next = if reads == 1 {
                    registry.cancel_request("cancel-body").unwrap();
                    Some(b"partial".to_vec())
                } else {
                    None
                };
                async move { Ok::<_, ()>(next) }
            },
            64,
            &cancellation,
        ));
        assert_eq!(result, Err(HttpExecutionErrorV1::OutcomeUnknown));
        assert_eq!(reads, 1);
    }

    #[test]
    fn private_and_special_addresses_are_rejected_from_dns_results() {
        for address in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 127, 255, 254)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 0, 9)),
            IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(198, 19, 255, 254)),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V6("2001:db8::1".parse().unwrap()),
            IpAddr::V6("2001:0::1".parse().unwrap()),
            IpAddr::V6("2002::1".parse().unwrap()),
            IpAddr::V6("fc00::1".parse().unwrap()),
        ] {
            assert!(!is_public_unicast(address), "accepted {address}");
        }
        assert!(is_public_unicast(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(is_public_unicast(IpAddr::V6(
            "2606:4700:4700::1111".parse().unwrap()
        )));
    }

    #[test]
    fn every_dns_answer_must_be_public_and_peer_must_match_a_pinned_answer() {
        let public = SocketAddr::from(([8, 8, 8, 8], 443));
        let private = SocketAddr::from(([127, 0, 0, 1], 443));
        assert!(validate_resolved_addresses(&[public]).is_ok());
        assert_eq!(
            validate_resolved_addresses(&[public, private]),
            Err(HttpExecutionErrorV1::AddressDenied)
        );
        assert!(verify_connected_peer(&[public], public).is_ok());
        assert_eq!(
            verify_connected_peer(&[public], private),
            Err(HttpExecutionErrorV1::AddressDenied)
        );
        assert_eq!(
            validate_resolved_addresses(&vec![public; MAX_HTTP_DNS_ADDRESSES + 1]),
            Err(HttpExecutionErrorV1::AddressDenied)
        );
    }

    #[test]
    fn request_metadata_rejects_raw_credentials_and_unapproved_headers() {
        let mut request = HttpRequestV1::keyless(
            "eff_1",
            "challenge_1",
            "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "default.search",
            "https://search.example.test/v1/search?q=hello",
            b"{}".to_vec(),
        );
        request
            .headers
            .push(("authorization".into(), "Bearer secret".into()));
        assert_eq!(
            validate_request(&route(), &request),
            Err(HttpExecutionErrorV1::CredentialsUnavailable)
        );

        request.headers.clear();
        request.credential_ref = Some("cred_1".into());
        assert_eq!(
            validate_request(&route(), &request),
            Err(HttpExecutionErrorV1::CredentialsUnavailable)
        );

        request.credential_ref = None;
        request
            .headers
            .push(("x-forwarded-host".into(), "internal".into()));
        assert_eq!(
            validate_request(&route(), &request),
            Err(HttpExecutionErrorV1::InvalidRequest)
        );

        request.headers.clear();
        request.body = b"not-json".to_vec();
        assert_eq!(
            validate_request(&route(), &request),
            Err(HttpExecutionErrorV1::InvalidRequest)
        );
    }

    #[test]
    fn retry_after_is_bounded_and_malformed_values_are_ignored() {
        assert_eq!(parse_retry_after_ms("3"), Some(3_000));
        assert_eq!(parse_retry_after_ms("0"), Some(0));
        assert_eq!(parse_retry_after_ms("999999"), Some(MAX_RETRY_AFTER_MS));
        assert_eq!(parse_retry_after_ms("soon"), None);
        assert_eq!(parse_retry_after_ms("-1"), None);
    }

    #[test]
    fn cancelled_request_is_denied_before_dns_or_network() {
        let registry = crate::request_cancellation::RequestCancellationRegistry::new(
            std::num::NonZeroUsize::new(1).unwrap(),
        );
        let active = registry.register("cancel-before-send").unwrap();
        registry.cancel_request("cancel-before-send").unwrap();
        let request = HttpRequestV1::keyless(
            "eff_1",
            "challenge_1",
            "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "default.search",
            "https://search.example.test/v1/search?q=hello",
            b"{}".to_vec(),
        );
        let mut request = request;
        request.max_response_bytes = route().max_response_bytes;
        request.timeout_ms = route().timeout_ms;
        assert_eq!(
            execute_pinned(&route(), &request, &active.cancellation()),
            Err(HttpExecutionErrorV1::Cancelled)
        );
    }
}
