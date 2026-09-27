//! Dependency-free bounded process execution with a wall-clock watchdog.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::SandboxError;
use crate::provider::SandboxCommand;

/// The raw captured output of a process.
#[derive(Debug, Default)]
pub(crate) struct RawOutput {
    /// The exit code, when the process exited normally.
    pub exit_code: Option<i32>,
    /// Captured stdout bytes (bounded).
    pub stdout: Vec<u8>,
    /// Captured stderr bytes (bounded).
    pub stderr: Vec<u8>,
    /// Whether the watchdog killed the process.
    pub timed_out: bool,
}

/// Runs `command`, capturing bounded stdout/stderr with an optional timeout.
///
/// # Errors
/// Returns [`SandboxError::Io`] when the process cannot be spawned or waited on.
pub(crate) fn run_process(
    command: &mut Command,
    stdin: Option<&str>,
    timeout: Option<Duration>,
    max_bytes: usize,
) -> Result<RawOutput, SandboxError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .map_err(|error| SandboxError::Io(error.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SandboxError::Io("child stdout unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SandboxError::Io("child stderr unavailable".to_owned()))?;
    let out_handle = std::thread::spawn(move || read_bounded(stdout, max_bytes));
    let err_handle = std::thread::spawn(move || read_bounded(stderr, max_bytes));
    if let Some(data) = stdin
        && let Some(mut sink) = child.stdin.take()
    {
        let _ = sink.write_all(data.as_bytes());
        let _ = sink.flush();
        drop(sink);
    }
    let start = Instant::now();
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if let Some(limit) = timeout
                    && start.elapsed() >= limit
                {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(SandboxError::Io(error.to_string())),
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(RawOutput {
        exit_code,
        stdout,
        stderr,
        timed_out,
    })
}

/// Builds a host `Command` from a sandbox command, for the explicit bare path.
pub(crate) fn host_command(command: &SandboxCommand) -> Command {
    let mut host = Command::new(&command.program);
    host.args(&command.args);
    if let Some(cwd) = &command.cwd {
        host.current_dir(cwd);
    }
    for (key, value) in &command.env {
        host.env(key, value);
    }
    host
}

/// Reads a stream to EOF, retaining at most `max_bytes`.
fn read_bounded(mut reader: impl Read, max_bytes: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if kept.len() < max_bytes {
                    let remaining = max_bytes - kept.len();
                    kept.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
            Err(_) => break,
        }
    }
    kept
}
