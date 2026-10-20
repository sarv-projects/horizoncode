//! Guarded outbound HTTP execution primitives.
//!
//! This module is intentionally not connected to the RPC dispatcher until the durable
//! HTTP lease/receipt transaction is wired. It owns no auth headers, arbitrary destination
//! URLs, redirects, or provider fallback policy. Credentialed routes remain unavailable
//! until a trusted SecretBroker resolver exists.

use std::future::Future;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
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
    pub connected_peer: IpAddr,
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
    pub http_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub body_digest: Option<String>,
    pub body_bytes: u64,
    pub body_truncated: bool,
    pub connected_peer: Option<IpAddr>,
    pub receipt_digest: Option<String>,
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
    pub connected_peer: IpAddr,
    pub receipt_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpExecutionRecoveryV1 {
    pub binding: HttpExecutionBindingV1,
    pub status: HttpExecutionStatusV1,
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
    let mut response = await_cancellable(
        client
            .post(&request.target)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(request.body.clone())
            .send(),
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
        connected_peer: peer.ip(),
    })
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
