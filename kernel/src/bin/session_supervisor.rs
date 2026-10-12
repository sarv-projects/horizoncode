//! One-connection Linux Session observer and guarded ToolBatch effect endpoint.
//!
//! The process owns a private supervisor lease, opens OpenCode SQLite read-only, validates
//! the EventV2 contract, and serves authenticated Session pages plus approved workspace
//! file writes. It never invokes OpenCode providers or writes the source DB.
//!
//! Usage: session_supervisor --source=FILE --state-dir=DIR --socket=PATH --host-exe=FILE
//!                         --session=ID --nonce=VALUE --incarnation=VALUE
//!                         [--workspace-root=DIR]

use horizoncode_kernel::effect_host::EffectHost;
use horizoncode_kernel::protocol::{
    FEATURE_EFFECTS_V2, FEATURE_SESSION_PAGE_CONTROL_V1, HandshakePolicy, RpcControlV1,
    RpcMessageV1,
};
use horizoncode_kernel::session_projection::{SessionProjection, SubscriptionPageError};
use horizoncode_kernel::supervisor_lease::SupervisorLease;
use horizoncode_kernel::supervisor_session::{AuthenticatedKernelSession, SupervisorSessionError};
use horizoncode_kernel::unix_peer::{UnixPeerListener, UnixPeerPolicy};
use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const PAGE_CAPACITY: usize = 64;
const SYNC_BATCH: usize = 512;

fn digest_host_executable(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("host executable path must be absolute".to_owned());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("host executable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("host executable must be a regular non-symlink file".to_owned());
    }
    let mut file =
        fs::File::open(path).map_err(|error| format!("open host executable: {error}"))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|error| format!("read host executable: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

#[derive(Debug)]
struct Options {
    source: PathBuf,
    state_dir: PathBuf,
    socket: PathBuf,
    host_exe: PathBuf,
    session_id: String,
    nonce: String,
    incarnation: String,
    workspace_root: Option<PathBuf>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut fields = std::collections::BTreeMap::new();
    for arg in args {
        let (key, value) = arg
            .split_once('=')
            .ok_or_else(|| "arguments must use --name=value".to_owned())?;
        let key = key
            .strip_prefix("--")
            .ok_or_else(|| "arguments must start with --".to_owned())?;
        if !matches!(
            key,
            "source"
                | "state-dir"
                | "socket"
                | "host-exe"
                | "session"
                | "nonce"
                | "incarnation"
                | "workspace-root"
        ) || value.is_empty()
            || fields.insert(key.to_owned(), value.to_owned()).is_some()
        {
            return Err("unknown, duplicate, or empty supervisor argument".to_owned());
        }
    }
    let take = |fields: &mut std::collections::BTreeMap<String, String>, key: &str| {
        fields
            .remove(key)
            .ok_or_else(|| format!("missing --{key}=VALUE"))
    };
    let options = Options {
        source: take(&mut fields, "source")?.into(),
        state_dir: take(&mut fields, "state-dir")?.into(),
        socket: take(&mut fields, "socket")?.into(),
        host_exe: take(&mut fields, "host-exe")?.into(),
        session_id: take(&mut fields, "session")?,
        nonce: take(&mut fields, "nonce")?,
        incarnation: take(&mut fields, "incarnation")?,
        workspace_root: fields.remove("workspace-root").map(PathBuf::from),
    };
    if !fields.is_empty() {
        return Err("unexpected supervisor argument".to_owned());
    }
    if !options.source.is_absolute()
        || !options.state_dir.is_absolute()
        || !options.socket.is_absolute()
        || !options.host_exe.is_absolute()
        || options
            .workspace_root
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
    {
        return Err(
            "database, state, socket, executable and workspace paths must be absolute".to_owned(),
        );
    }
    Ok(options)
}

fn ensure_source(path: &Path) -> Result<(PathBuf, Connection), String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("source path: {error}"))?;
    let metadata = fs::metadata(&canonical).map_err(|error| format!("source metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("OpenCode source must be a regular SQLite file".to_owned());
    }
    let source = Connection::open_with_flags(
        &canonical,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("open OpenCode source read-only: {error}"))?;
    source
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("set source query-only: {error}"))?;
    let integrity: String = source
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("check OpenCode SQLite integrity: {error}"))?;
    if integrity != "ok" {
        return Err("OpenCode SQLite integrity check failed".to_owned());
    }
    let columns = source
        .prepare("PRAGMA table_info(event)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<BTreeSet<_>, _>>()
        })
        .map_err(|error| format!("inspect OpenCode EventV2 table: {error}"))?;
    let required = BTreeSet::from([
        "id".to_owned(),
        "aggregate_id".to_owned(),
        "seq".to_owned(),
        "type".to_owned(),
        "data".to_owned(),
    ]);
    if !required.is_subset(&columns) {
        return Err("OpenCode EventV2 table is missing required columns".to_owned());
    }
    Ok((canonical, source))
}

fn ensure_projection_path(state_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let projection = state_dir.join("session-projection.sqlite");
    if let Ok(metadata) = fs::symlink_metadata(&projection)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("projection path must be a regular non-symlink file".to_owned());
    }
    if projection.exists() {
        let canonical = fs::canonicalize(&projection)
            .map_err(|error| format!("canonicalize projection: {error}"))?;
        if canonical == source {
            return Err("OpenCode source and projection must be distinct files".to_owned());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let source_metadata = fs::metadata(source).map_err(|error| error.to_string())?;
            let projection_metadata =
                fs::metadata(&canonical).map_err(|error| error.to_string())?;
            if source_metadata.dev() == projection_metadata.dev()
                && source_metadata.ino() == projection_metadata.ino()
            {
                return Err("OpenCode source and projection must not be hardlinks".to_owned());
            }
        }
    }
    Ok(projection)
}

fn sync_session(
    projection: &mut SessionProjection,
    source: &Connection,
    session_id: &str,
) -> Result<(), String> {
    loop {
        let report = projection
            .sync(source, session_id, SYNC_BATCH)
            .map_err(|error| format!("project OpenCode events: {error}"))?;
        if report.imported < SYNC_BATCH {
            return Ok(());
        }
    }
}

fn run(options: Options) -> Result<(), String> {
    let state_dir = fs::canonicalize(&options.state_dir)
        .map_err(|error| format!("state directory: {error}"))?;
    if state_dir != options.state_dir {
        return Err("state directory must be canonical".to_owned());
    }
    let lease = SupervisorLease::acquire(&state_dir).map_err(|error| error.to_string())?;
    let mut effects = EffectHost::open(&state_dir, options.workspace_root.as_deref())?;
    let (source_path, source) = ensure_source(&options.source)?;
    if fs::canonicalize(options.socket.parent().ok_or("socket path has no parent")?)
        .map_err(|error| format!("socket parent: {error}"))?
        != state_dir
    {
        return Err("socket must be directly inside the supervisor state directory".to_owned());
    }
    let projection_path = ensure_projection_path(&state_dir, &source_path)?;
    let projection_db = Connection::open(&projection_path)
        .map_err(|error| format!("open projection database: {error}"))?;
    if projection_path.exists() {
        fs::set_permissions(&projection_path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("secure projection database: {error}"))?;
    }
    let projection_integrity: String = projection_db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("check projection database: {error}"))?;
    if projection_integrity != "ok" {
        return Err("projection SQLite integrity check failed".to_owned());
    }
    let mut projection = SessionProjection::open(projection_db)
        .map_err(|error| format!("open Session projection: {error}"))?;
    // Validate and recover this Session before exposing a listener or READY status.
    sync_session(&mut projection, &source, &options.session_id)?;

    let host_exe =
        fs::canonicalize(&options.host_exe).map_err(|error| format!("host executable: {error}"))?;
    let listener = UnixPeerListener::bind(
        &options.socket,
        UnixPeerPolicy {
            uid: unsafe { libc::geteuid() },
            executable: host_exe,
        },
    )
    .map_err(|error| format!("bind supervisor socket: {error}"))?;
    let (channel, _) = listener
        .accept_authenticated()
        .map_err(|error| format!("authenticate host process: {error}"))?;
    let policy = HandshakePolicy {
        min_protocol: 1,
        max_protocol: 1,
        supported_features: BTreeSet::from([
            "session.events.v1".to_owned(),
            FEATURE_SESSION_PAGE_CONTROL_V1.to_owned(),
            FEATURE_EFFECTS_V2.to_owned(),
        ]),
        expected_supervisor_nonce: options.nonce,
        expected_host_process_incarnation: Some(options.incarnation),
    };
    let mut session = AuthenticatedKernelSession::new(channel);
    let effect_feature_enabled = match session
        .negotiate(&policy)
        .map_err(|error| format!("negotiate host protocol: {error}"))?
    {
        horizoncode_kernel::rpc_handshake::HelloOutcome::Negotiated(result) => result
            .enabled_features
            .iter()
            .any(|feature| feature.as_str() == FEATURE_EFFECTS_V2),
        horizoncode_kernel::rpc_handshake::HelloOutcome::Rejected(error) => {
            return Err(format!("host protocol rejected: {}", error.code));
        }
    };
    session
        .canonical_state_validated()
        .map_err(|error| error.to_string())?;
    session
        .owner_epoch_acquired(&lease)
        .map_err(|error| error.to_string())?;
    session
        .recovery_reconciled()
        .map_err(|error| error.to_string())?;
    session
        .required_services_ready()
        .map_err(|error| error.to_string())?;

    let mut active_subscription: Option<String> = None;
    loop {
        let message = match session.next_application_message() {
            Ok(message) => message,
            // EOF while idle is the host's graceful shutdown after READY. During page ACK
            // delivery it remains an error, because that path is handled by the sender.
            Err(SupervisorSessionError::Closed) => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        match message {
            RpcMessageV1::Request(request) => {
                let response =
                    effects.handle_request(&options.session_id, &request, effect_feature_enabled);
                session
                    .write_application_message(&RpcMessageV1::Response(Box::new(response)))
                    .map_err(|error| error.to_string())?;
            }
            RpcMessageV1::Control(control) => match *control {
                RpcControlV1::Unsubscribe { subscription_id }
                    if active_subscription.as_deref() == Some(&subscription_id) =>
                {
                    return Ok(());
                }
                RpcControlV1::Subscribe {
                    subscription_id,
                    owner_kind,
                    owner_id,
                    after: Some(after),
                } => {
                    if owner_kind != "session" || owner_id != options.session_id {
                        return Err(
                            "Subscribe owner is outside the validated Session scope".to_owned()
                        );
                    }
                    if active_subscription
                        .as_ref()
                        .is_some_and(|active| active != &subscription_id)
                    {
                        return Err("connection cannot change its subscription identity".to_owned());
                    }
                    active_subscription = Some(subscription_id.clone());
                    sync_session(&mut projection, &source, &options.session_id)?;
                    match session.send_subscription_page_with_requests(
                        &projection,
                        &subscription_id,
                        &after,
                        PAGE_CAPACITY,
                        |request| {
                            effects.handle_request(
                                &options.session_id,
                                &request,
                                effect_feature_enabled,
                            )
                        },
                    ) {
                        Ok(_) => {}
                        Err(SupervisorSessionError::ProjectionSubscription(
                            SubscriptionPageError::ResnapshotRequired,
                        )) => {
                            let latest = projection
                                .subscription_cursor(&options.session_id)
                                .map_err(|error| error.to_string())?;
                            session
                                .send_resnapshot_required(&subscription_id, &after, &latest)
                                .map_err(|error| error.to_string())?;
                            return Ok(());
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
                _ => {
                    return Err(
                        "Session observer expected Subscribe or matching Unsubscribe".into(),
                    );
                }
            },
            _ => return Err("supervisor expected an application request or control".to_owned()),
        }
    }
}

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let [argument] = args.as_slice()
        && let Some(path) = argument.strip_prefix("--digest-host-executable=")
    {
        return match digest_host_executable(path) {
            Ok(digest) => {
                println!("{digest}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("host executable digest failed: {error}");
                ExitCode::FAILURE
            }
        };
    }
    let options = match parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("session supervisor arguments rejected: {error}");
            return ExitCode::from(2);
        }
    };
    match run(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("session supervisor failed: {error}");
            ExitCode::FAILURE
        }
    }
}
