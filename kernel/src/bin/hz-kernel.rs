//! Host-scoped kernel owner for effects.v2.
//!
//! Usage: hz-kernel --state-dir=DIR --socket=PATH --host-exe=FILE --nonce=VALUE --incarnation=VALUE

#[cfg(target_os = "linux")]
mod linux {
    use horizoncode_kernel::host_kernel::HostKernel;
    use horizoncode_kernel::protocol::{
        AuthenticatedPrincipalV1, AuthenticatedRequestContextV1, FEATURE_EFFECTS_MULTI_CALL,
        FEATURE_EFFECTS_V2, FEATURE_REPO_INTEL_READ_CONTEXT_V1, FEATURE_WEB_SEARCH_CASCADE_V1,
        FEATURE_ARTIFACT_READ_CONTEXT_V1,
        FEATURE_RESOURCE_POLICY_INGRESS_V1,
        FrameFence, HandshakePolicy,
        RpcControlV1, RpcMessageV1, RpcOutcomeV1, read_message, write_message,
    };
    use horizoncode_kernel::request_cancellation::{ActiveRequest, RequestCancellationRegistry};
    use horizoncode_kernel::rpc_handshake::{HelloOutcome, serve_authenticated_unix_hello};
    use horizoncode_kernel::startup::StartupGate;
    use horizoncode_kernel::supervisor_lease::SupervisorLease;
    use horizoncode_kernel::unix_peer::{UnixPeerListener, UnixPeerPolicy};
    use std::collections::BTreeSet;
    use std::fs;
    use std::io::Write;
    use std::num::NonZeroUsize;
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;

    #[derive(Debug)]
    struct Options {
        state_dir: PathBuf,
        codemode_helper_root: Option<PathBuf>,
        socket: PathBuf,
        host_exe: PathBuf,
        nonce: String,
        incarnation: String,
    }

    struct ReaderMessage {
        message: RpcMessageV1,
        active_request: Option<ActiveRequest>,
        authenticated_principal: Option<AuthenticatedPrincipalV1>,
        authenticated_context: Option<AuthenticatedRequestContextV1>,
    }

    const MAX_ACTIVE_REQUESTS: usize = 16;

    /// Observer invocation used by Core before launch: hash one validated regular
    /// executable and print only its canonical BLAKE3 digest. No sockets, lease files,
    /// state directories, or child processes are created.
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

    fn parse(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
        let mut values = std::collections::BTreeMap::new();
        for arg in args {
            let (key, value) = arg
                .split_once('=')
                .ok_or("arguments must use --name=value")?;
            let key = key
                .strip_prefix("--")
                .ok_or("arguments must start with --")?;
            if !matches!(
                key,
                "state-dir" | "codemode-helper-root" | "socket" | "host-exe" | "nonce" | "incarnation"
            ) || value.is_empty()
                || values.insert(key.to_owned(), value.to_owned()).is_some()
            {
                return Err("unknown, duplicate, or empty hz-kernel argument".to_owned());
            }
        }
        let codemode_helper_root = values.remove("codemode-helper-root").map(PathBuf::from);
        let mut take = |key: &str| {
            values
                .remove(key)
                .ok_or_else(|| format!("missing --{key}=VALUE"))
        };
        let options = Options {
            state_dir: take("state-dir")?.into(),
            codemode_helper_root,
            socket: take("socket")?.into(),
            host_exe: take("host-exe")?.into(),
            nonce: take("nonce")?,
            incarnation: take("incarnation")?,
        };
        if !values.is_empty()
            || !options.state_dir.is_absolute()
            || !options.socket.is_absolute()
            || !options.host_exe.is_absolute()
            || options.codemode_helper_root.as_ref().is_some_and(|path| !path.is_absolute())
            || options.nonce.len() > 256
            || options.incarnation.is_empty()
            || options.incarnation.len() > 256
        {
            return Err("hz-kernel paths must be absolute and identity values bounded".to_owned());
        }
        Ok(options)
    }

    fn send_status(
        stream: &mut horizoncode_kernel::unix_peer::AuthenticatedUnixStream,
        gate: &StartupGate,
    ) -> Result<(), String> {
        write_message(
            stream,
            &RpcMessageV1::StartupStatus(Box::new(gate.status())),
        )
        .map_err(|error| error.to_string())?;
        stream.flush().map_err(|error| error.to_string())
    }

    fn run(options: Options) -> Result<(), String> {
        let canonical_state = fs::canonicalize(&options.state_dir)
            .map_err(|error| format!("host state directory: {error}"))?;
        if canonical_state != options.state_dir {
            return Err("host state directory must be canonical".to_owned());
        }
        let canonical_exe = fs::canonicalize(&options.host_exe)
            .map_err(|error| format!("host executable: {error}"))?;
        let executable_metadata = fs::symlink_metadata(&canonical_exe)
            .map_err(|error| format!("host executable metadata: {error}"))?;
        if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
            return Err("host executable must be a regular file".to_owned());
        }

        // The lock and monotonically increasing epoch are host-scoped, not Session-scoped.
        let lease = SupervisorLease::acquire(&canonical_state)
            .map_err(|error| format!("acquire host owner lease: {error}"))?;
        // Load durable Location bindings and reconcile each matching EffectHost database
        // before accepting Core or announcing READY; UNKNOWN is retained unless target
        // evidence proves the after-state.
        let code_mode_root = options
            .codemode_helper_root
            .as_deref()
            .map(fs::canonicalize)
            .transpose()
            .map_err(|error| format!("CodeMode helper installation root: {error}"))?;
        if code_mode_root.as_deref() != options.codemode_helper_root.as_deref() {
            return Err("CodeMode helper installation root must be canonical".to_owned());
        }
        let mut host = HostKernel::open_with_code_mode_install_root(
            &canonical_state,
            code_mode_root.as_deref(),
        )?;
        // Worker intents/process leases share the host supervisor epoch. Replay and
        // conservative UNKNOWN recovery must finish before this process can report READY.
        host.open_worker_owner(lease.epoch())?;
        let listener = UnixPeerListener::bind(
            &options.socket,
            UnixPeerPolicy {
                uid: unsafe { libc::geteuid() },
                executable: canonical_exe,
            },
        )
        .map_err(|error| format!("bind authenticated host socket: {error}"))?;
        let (mut stream, peer) = listener
            .accept_authenticated()
            .map_err(|error| format!("authenticate Core peer: {error}"))?;
        let principal = format!("host_os_uid:{}", peer.uid());

        let mut gate = StartupGate::new();
        gate.record_peer_authenticated()
            .map_err(|error| error.to_string())?;
        // Do not negotiate the effect/execution surface until the selected Guard
        // process backend has proved its required OS guarantees on this host.
        let guard_execution_ready = host.guard_execution_backend_ready().is_ok();
        let mut supported_features = BTreeSet::new();
        if guard_execution_ready {
            supported_features.insert(FEATURE_EFFECTS_V2.to_owned());
            supported_features.insert(FEATURE_EFFECTS_MULTI_CALL.to_owned());
            // RepoIntel uses a separate out-of-body RepoRead context and its own
            // read-only HostKernel grant. Offer it only when the same enforced
            // OS backend required by Guard is available on this connection.
            supported_features.insert(FEATURE_REPO_INTEL_READ_CONTEXT_V1.to_owned());
            // The fixed no-key route cascade uses the already recovered EffectHost
            // HTTP journal and requires the same enforced Guard backend.
            supported_features.insert(FEATURE_WEB_SEARCH_CASCADE_V1.to_owned());
        }
        if cfg!(target_os = "linux") {
            supported_features.insert(FEATURE_ARTIFACT_READ_CONTEXT_V1.to_owned());
        }
        supported_features.insert(FEATURE_RESOURCE_POLICY_INGRESS_V1.to_owned());
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 1,
            supported_features,
            expected_supervisor_nonce: options.nonce,
            expected_host_process_incarnation: Some(options.incarnation.clone()),
            owner_epoch: lease.epoch(),
        };
        let (effects_negotiated, repo_intel_negotiated, web_search_cascade_negotiated, artifact_reads_negotiated, resource_policy_negotiated) =
            match serve_authenticated_unix_hello(&mut stream, &policy)
                .map_err(|error| format!("negotiate host hello: {error}"))?
            {
                // A peer that does not negotiate `effects.v2` still gets a healthy host; every
                // effect RPC for that connection fails closed with `feature_not_negotiated`.
                HelloOutcome::Negotiated(result) => (
                    result
                        .enabled_features
                        .iter()
                        .any(|feature| feature == FEATURE_EFFECTS_V2),
                    result
                        .enabled_features
                        .iter()
                        .any(|feature| feature == FEATURE_REPO_INTEL_READ_CONTEXT_V1),
                    result
                        .enabled_features
                        .iter()
                        .any(|feature| feature == FEATURE_WEB_SEARCH_CASCADE_V1),
                    result
                        .enabled_features
                        .iter()
                        .any(|feature| feature == FEATURE_ARTIFACT_READ_CONTEXT_V1),
                    result
                        .enabled_features
                        .iter()
                        .any(|feature| feature == FEATURE_RESOURCE_POLICY_INGRESS_V1),
                ),
                HelloOutcome::Rejected(_) => return Err("Core hello was rejected".to_owned()),
            };
        gate.record_hello_negotiated()
            .map_err(|error| error.to_string())?;
        send_status(&mut stream, &gate)?;
        gate.record_canonical_state_validated()
            .map_err(|error| error.to_string())?;
        gate.record_owner_epoch_acquired(lease.epoch())
            .map_err(|error| error.to_string())?;
        send_status(&mut stream, &gate)?;
        // This milestone means per-Location recovery completed. UNKNOWN remains blocked
        // and is exposed only through the authenticated read-only receipt query.
        gate.record_recovery_reconciled()
            .map_err(|error| error.to_string())?;
        send_status(&mut stream, &gate)?;
        gate.record_required_services_ready()
            .map_err(|error| error.to_string())?;
        // `HostKernel::open` has completed durable receipt recovery and the startup
        // gate has authenticated the peer, fenced the epoch, and marked all required
        // services ready. Effects remain disabled if either that recovery or the OS
        // confinement preflight did not succeed.
        host.set_effects_enabled(guard_execution_ready && effects_negotiated);
        host.set_web_search_cascade_enabled(
            guard_execution_ready && effects_negotiated && web_search_cascade_negotiated,
        );
        // Negotiation is connection-scoped. The dispatcher still validates the
        // authenticated ServerAuth subject, registered Location owner, current
        // files.read grant, generation pin and expiry before each read.
        host.set_repo_intel_enabled(guard_execution_ready && repo_intel_negotiated);
        host.set_artifact_reads_enabled(artifact_reads_negotiated);
        host.set_resource_policy_enabled(resource_policy_negotiated);
        send_status(&mut stream, &gate)?;

        // The negotiated HelloResult echoes the Core process incarnation that
        // was checked against this launch's expected incarnation by
        // `serve_authenticated_unix_hello`. Frames and the private OS peer
        // context therefore share the same authenticated Core generation.
        let fence = FrameFence::new(lease.epoch(), options.incarnation)
            .map_err(|error| format!("host frame fence: {error}"))?;
        host.bind_authenticated_core_peer(&peer, &fence)
            .map_err(|error| format!("bind authenticated Core process identity: {error}"))?;
        let mut reader = stream
            .try_clone()
            .map_err(|error| format!("clone authenticated host reader: {error}"))?;
        let cancellations = RequestCancellationRegistry::new(
            NonZeroUsize::new(MAX_ACTIVE_REQUESTS).expect("active request limit is nonzero"),
        );
        let reader_cancellations = cancellations.clone();
        let reader_fence = fence.clone();
        let (reader_tx, reader_rx) = std::sync::mpsc::sync_channel(MAX_ACTIVE_REQUESTS);
        let reader_thread = std::thread::spawn(move || {
            loop {
                let result = match read_message(&mut reader) {
                    Err(error) => Err(error.to_string()),
                    Ok(None) => Ok(None),
                    Ok(Some(RpcMessageV1::Control(control)))
                        if matches!(control.as_ref(), RpcControlV1::CancelRequest { .. }) =>
                    {
                        // Route cancellation on the reader thread so a synchronous
                        // terminal.run handler can observe it while the dispatcher is
                        // waiting for process exit. The registry validates the negotiated
                        // owner epoch and process incarnation before signaling.
                        let _ = reader_cancellations.route_control(&control, &reader_fence);
                        continue;
                    }
                    Ok(Some(RpcMessageV1::Request(request))) => {
                        match reader_cancellations.register(&request.request_id) {
                            Ok(active_request) => Ok(Some(ReaderMessage {
                                message: RpcMessageV1::Request(request),
                                active_request: Some(active_request),
                                authenticated_principal: None,
                                authenticated_context: None,
                            })),
                            Err(error) => Err(error.to_string()),
                        }
                    }
                    Ok(Some(RpcMessageV1::AuthenticatedRequest {
                        request,
                        principal,
                        context,
                    })) => match reader_cancellations.register(&request.request_id) {
                        Ok(active_request) => Ok(Some(ReaderMessage {
                            message: RpcMessageV1::Request(request),
                            active_request: Some(active_request),
                            authenticated_principal: Some(principal),
                            authenticated_context: context,
                        })),
                        Err(error) => Err(error.to_string()),
                    },
                    Ok(Some(message)) => Ok(Some(ReaderMessage {
                        message,
                        active_request: None,
                        authenticated_principal: None,
                        authenticated_context: None,
                    })),
                };
                let done = !matches!(&result, Ok(Some(_)));
                if reader_tx.send(result).is_err() || done {
                    break;
                }
            }
        });
        let service_result = (|| -> Result<(), String> {
            loop {
                match reader_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                    Ok(Ok(Some(inbound))) => {
                        let ReaderMessage {
                            message,
                            active_request,
                            authenticated_principal,
                            authenticated_context,
                        } = inbound;
                        match message {
                            RpcMessageV1::Request(request) => {
                                let active_request = active_request.ok_or_else(|| {
                                    "host request has no cancellation registration".to_owned()
                                })?;
                                let response = match authenticated_principal.as_ref() {
                                    Some(authenticated_principal) => host
                                        .handle_authenticated_request_with_context_and_cancellation(
                                            &request,
                                            authenticated_principal,
                                            &fence,
                                            authenticated_context.as_ref(),
                                            Some(active_request.cancellation()),
                                        ),
                                    None => host
                                        .handle_request_with_authenticated_context_and_cancellation(
                                            &request,
                                            &principal,
                                            &fence,
                                            authenticated_context.as_ref(),
                                            Some(active_request.cancellation()),
                                        ),
                                };
                                drop(active_request);
                                if response.outcome == RpcOutcomeV1::Ok && response.body.is_none() {
                                    return Err(
                                        "host returned an invalid success response".to_owned()
                                    );
                                }
                                write_message(
                                    &mut stream,
                                    &RpcMessageV1::Response(Box::new(response)),
                                )
                                .map_err(|error| error.to_string())?;
                                for event in host.poll_terminal_events(&fence) {
                                    write_message(&mut stream, &event)
                                        .map_err(|error| error.to_string())?;
                                }
                            }
                            RpcMessageV1::Control(control) => {
                                if active_request.is_some() {
                                    return Err(
                                        "host control has a request registration".to_owned()
                                    );
                                }
                                let mut outgoing = host.handle_terminal_control(&control, &fence);
                                outgoing.extend(host.poll_terminal_events(&fence));
                                for message in outgoing {
                                    write_message(&mut stream, &message)
                                        .map_err(|error| error.to_string())?;
                                }
                            }
                            _ => return Err("unsupported host IPC frame".to_owned()),
                        }
                    }
                    Ok(Ok(None)) => break,
                    Ok(Err(error)) => return Err(error),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        for event in host.poll_terminal_events(&fence) {
                            write_message(&mut stream, &event)
                                .map_err(|error| error.to_string())?;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("authenticated host reader stopped unexpectedly".to_owned());
                    }
                }
                stream.flush().map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        drop(reader_rx);
        let _ = stream.shutdown();
        if reader_thread.join().is_err() {
            return Err("authenticated host reader panicked".to_owned());
        }
        service_result
    }

    pub fn main() -> ExitCode {
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
        match parse(args).and_then(run) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("hz-kernel: {error}");
                ExitCode::FAILURE
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn args() -> Vec<String> {
            vec![
                "--state-dir=/tmp/hz-state".to_owned(),
                "--socket=/tmp/hz.sock".to_owned(),
                "--host-exe=/usr/bin/bun".to_owned(),
                "--nonce=nonce".to_owned(),
                "--incarnation=incarnation".to_owned(),
            ]
        }

        #[test]
        fn parses_core_launch_arguments() {
            let parsed = parse(args()).unwrap();
            assert_eq!(parsed.state_dir, Path::new("/tmp/hz-state"));
            assert_eq!(parsed.socket, Path::new("/tmp/hz.sock"));
            assert_eq!(parsed.nonce, "nonce");
        }

        #[test]
        fn rejects_missing_duplicate_and_unknown_arguments() {
            let mut missing = args();
            missing.pop();
            assert!(parse(missing).is_err());
            let mut duplicate = args();
            duplicate.push("--nonce=other".to_owned());
            assert!(parse(duplicate).is_err());
            let mut unknown = args();
            unknown.push("--workspace-root=/tmp".to_owned());
            assert!(parse(unknown).is_err());
        }

        #[test]
        fn rejects_relative_paths_and_empty_incarnation() {
            let mut relative = args();
            relative[0] = "--state-dir=state".to_owned();
            assert!(parse(relative).is_err());
            let mut empty = args();
            empty[4] = "--incarnation=".to_owned();
            assert!(parse(empty).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    linux::main()
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("hz-kernel is unavailable on this platform");
    std::process::ExitCode::FAILURE
}
