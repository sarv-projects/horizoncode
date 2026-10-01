//! AX-124 diagnostic baseline for the existing headless CLI.
//!
//! Run manually in release mode with:
//! cargo test --release -p horizoncode-cli --test perf_baseline -- --ignored --nocapture
//!
//! This is intentionally not an ACC-PERF-01 acceptance test: the current product
//! has no interactive terminal renderer, composer, or managed-run controller.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use horizoncode_provider::testing::{MockServer, MockTurn};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

const TEXT_PROMPT: &str = "Return the single word benchmark.";
const TOOL_PROMPT: &str = "List the workspace files, then return the word benchmark.";

#[derive(Debug, Serialize)]
struct Sample {
    workload: &'static str,
    cache_state: &'static str,
    exit_code: Option<i32>,
    spawn_to_turn_started_ns: Option<u64>,
    spawn_to_dispatch_ns: Option<u64>,
    fixture_response_start_to_first_text_event_ns: Option<u64>,
    spawn_to_first_text_event_ns: Option<u64>,
    tool_started_to_tool_finished_ns: Option<u64>,
    spawn_to_turn_finished_ns: Option<u64>,
    spawn_to_process_exit_ns: u64,
    sampled_peak_rss_bytes: Option<u64>,
    stdout_bytes: u64,
    stdout_event_lines: u64,
    malformed_event_lines: u64,
    stderr_bytes: u64,
}

#[test]
fn percentile_uses_nearest_rank_and_reports_empty_samples() {
    assert_eq!(percentile(&[40, 10, 30, 20], 0.50), Some(20));
    assert_eq!(percentile(&[40, 10, 30, 20], 0.95), Some(40));
    assert_eq!(percentile(&[], 0.95), None);
}

#[test]
fn proc_status_rss_parser_is_unit_safe() {
    let status = "Name:\thorizoncode\nVmPeak:\t 900 kB\nVmRSS:\t1234 kB\n";
    assert_eq!(rss_bytes_from_proc_status(status), Some(1_234 * 1024));
    assert_eq!(rss_bytes_from_proc_status("Name:\thorizoncode\n"), None);
}

#[tokio::test]
#[ignore = "manual local performance capture; run in release mode on a named machine"]
async fn capture_headless_diagnostic_baseline() {
    let sample_count = std::env::var("HORIZONCODE_PERF_SAMPLES")
        .ok()
        .map(|value| {
            value
                .parse::<usize>()
                .expect("HORIZONCODE_PERF_SAMPLES must be an integer")
        })
        .unwrap_or(30);
    assert!(
        (6..=100).contains(&sample_count),
        "sample count must be between 6 and 100"
    );
    let tool_sample_count = (sample_count / 3).max(3);
    let root = workspace_root();
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_horizoncode"));
    let workspace = tempfile::tempdir().expect("create benchmark workspace");
    fs::write(workspace.path().join("alpha.txt"), "alpha\n").expect("write fixture");
    fs::write(workspace.path().join("beta.txt"), "beta\n").expect("write fixture");
    let home = tempfile::tempdir().expect("create isolated HorizonCode home");

    let mut scripted_turns = Vec::with_capacity(sample_count + tool_sample_count * 2);
    scripted_turns.extend((0..sample_count).map(|_| MockTurn::text("benchmark")));
    for _ in 0..tool_sample_count {
        scripted_turns.push(MockTurn::tool_call("list", json!({})));
        scripted_turns.push(MockTurn::text("benchmark"));
    }
    let server = MockServer::start(scripted_turns).await;

    let mut samples = Vec::with_capacity(sample_count + tool_sample_count);
    for index in 0..sample_count {
        samples.push(
            run_sample(
                &binary,
                workspace.path(),
                home.path(),
                &server,
                index,
                "text",
                if index == 0 {
                    "fresh-home-first-process"
                } else {
                    "repeated-process-warm-filesystem-cache-uncontrolled"
                },
            )
            .await,
        );
    }
    for index in 0..tool_sample_count {
        let request_index = sample_count + index * 2;
        samples.push(
            run_sample(
                &binary,
                workspace.path(),
                home.path(),
                &server,
                request_index,
                "list-tool",
                "repeated-process-warm-filesystem-cache-uncontrolled",
            )
            .await,
        );
    }

    let text_samples: Vec<_> = samples
        .iter()
        .filter(|sample| sample.workload == "text")
        .collect();
    let tool_samples: Vec<_> = samples
        .iter()
        .filter(|sample| sample.workload == "list-tool")
        .collect();
    assert_eq!(
        server.request_count(),
        sample_count + tool_sample_count * 2,
        "the local provider fixture must receive every scripted request"
    );
    let measurements = json!({
        "cli_spawn_to_turn_started_ns": summarize(samples.iter().filter_map(|sample| sample.spawn_to_turn_started_ns)),
        "cli_spawn_to_fixture_dispatch_ns": summarize(samples.iter().filter_map(|sample| sample.spawn_to_dispatch_ns)),
        "text_only_spawn_to_first_text_event_ns": summarize(text_samples.iter().filter_map(|sample| sample.spawn_to_first_text_event_ns)),
        "text_only_fixture_response_start_to_text_event_ns": summarize(text_samples.iter().filter_map(|sample| sample.fixture_response_start_to_first_text_event_ns)),
        "one_tool_spawn_to_first_text_event_ns": summarize(tool_samples.iter().filter_map(|sample| sample.spawn_to_first_text_event_ns)),
        "one_tool_fixture_response_start_to_text_event_ns": summarize(tool_samples.iter().filter_map(|sample| sample.fixture_response_start_to_first_text_event_ns)),
        "observed_tool_event_duration_ns": summarize(tool_samples.iter().filter_map(|sample| sample.tool_started_to_tool_finished_ns)),
        "text_only_cli_spawn_to_turn_finished_ns": summarize(text_samples.iter().filter_map(|sample| sample.spawn_to_turn_finished_ns)),
        "one_tool_cli_spawn_to_turn_finished_ns": summarize(tool_samples.iter().filter_map(|sample| sample.spawn_to_turn_finished_ns)),
        "cli_spawn_to_process_exit_ns": summarize(samples.iter().map(|sample| sample.spawn_to_process_exit_ns)),
        "text_only_sampled_child_peak_rss_bytes": summarize(text_samples.iter().filter_map(|sample| sample.sampled_peak_rss_bytes)),
        "one_tool_sampled_child_peak_rss_bytes": summarize(tool_samples.iter().filter_map(|sample| sample.sampled_peak_rss_bytes)),
    });
    let evidence = json!({
        "schema": "horizoncode.perf-baseline.v1",
        "scope": "headless-cli-diagnostic",
        "acceptance_verdict": "not-an-ACC-PERF-01-record",
        "limitations": [
            "No interactive terminal exists in this binary, so key-to-visible-feedback, composer readiness, first-token-to-paint, frame time, animation, slow-terminal redraw, and ANSI/color behavior are unmeasured.",
            "No managed Run controller exists, so queue, controller dispatch, cancellation acknowledgement, and managed orchestration costs are unmeasured.",
            "The scripted loopback provider has no model inference or external network latency; its response timing is a deterministic fixture observation, not provider latency.",
            "The process is connected to pipes, not a terminal. First text event is not a paint measurement.",
            "The first run has a fresh application home, but operating-system page cache is uncontrolled; later runs are repeated processes with filesystem cache state uncontrolled, not a true cold/warm OS cache pair.",
            "Linux RSS is sampled every 2 ms and can miss brief peaks; other operating systems report it unavailable in this harness."
        ],
        "captured_at_unix_ms": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_millis(),
        "source": {
            "git_revision": git_text(&root, &["rev-parse", "HEAD"])
                .expect("resolve exact source revision"),
            "git_worktree_dirty": !git_text(&root, &["status", "--porcelain", "--untracked-files=all"])
                .expect("read source worktree status")
                .trim()
                .is_empty(),
            "rust_source_tree_blake3": source_tree_digest(&root),
            "performance_contract_blake3": file_digest(&root.join("ARCH/contracts/PERFORMANCE.md")),
            "acceptance_matrix_blake3": file_digest(&root.join("ARCH/acceptance/ACCEPTANCE-MATRIX.md")),
        },
        "build": {
            "binary_path": binary,
            "binary_blake3": file_digest(&binary),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "rustc": command_version("rustc", &["--version"]),
        },
        "machine": machine_details(),
        "fixture": {
            "provider": "in-process 127.0.0.1 scripted OpenAI-compatible mock",
            "external_network": false,
            "terminal": "stdout/stderr pipes; no terminal renderer",
            "text_samples": sample_count,
            "tool_samples": tool_sample_count,
            "processes": samples.len(),
            "rss_sampler_interval_ms": 2,
            "operating_system_cache_controlled": false
        },
        "measurements": measurements,
        "raw_samples": samples
    });

    let output_path = std::env::var_os("HORIZONCODE_PERF_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target/perf/ax124-headless-diagnostic.json"));
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("create performance evidence directory");
    }
    fs::write(
        &output_path,
        serde_json::to_vec_pretty(&evidence).expect("serialize performance evidence"),
    )
    .expect("write performance evidence artifact");
    println!(
        "AX-124 headless diagnostic: {} samples; evidence {}; acceptance remains unmeasured",
        samples.len(),
        output_path.display()
    );
    println!(
        "Measurements: {}",
        serde_json::to_string(&evidence["measurements"]).expect("serialize summary")
    );
}

async fn run_sample(
    binary: &Path,
    workspace: &Path,
    home: &Path,
    server: &MockServer,
    request_index: usize,
    workload: &'static str,
    cache_state: &'static str,
) -> Sample {
    let mut command = Command::new(binary);
    command
        .args(["--format", "json", "-p"])
        .arg(if workload == "text" {
            TEXT_PROMPT
        } else {
            TOOL_PROMPT
        })
        .arg("--cwd")
        .arg(workspace)
        .env("HORIZONCODE_BASE_URL", server.base_url())
        .env("HORIZONCODE_API_KEY", "ax124-local-fixture-key")
        .env("HORIZONCODE_MODEL", "ax124-fixture-model")
        .env("HORIZONCODE_HOME", home)
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("ALL_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("all_proxy")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = Instant::now();
    let mut child = command.spawn().expect("spawn HorizonCode CLI");
    let pid = child.id();
    let rss_peak = Arc::new(AtomicU64::new(0));
    let sampler = pid.map(|pid| {
        let peak = rss_peak.clone();
        tokio::spawn(async move {
            loop {
                if let Some(bytes) = process_rss_bytes(pid) {
                    peak.fetch_max(bytes, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
    });
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_reader = tokio::spawn(async move {
        let mut reader = stderr;
        let mut contents = Vec::new();
        reader
            .read_to_end(&mut contents)
            .await
            .map(|_| contents.len())
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut stdout_bytes = 0_u64;
    let mut stdout_event_lines = 0_u64;
    let mut malformed_event_lines = 0_u64;
    let mut turn_started = None;
    let mut first_text = None;
    let mut tool_started = None;
    let mut tool_finished = None;
    let mut successful_list_settlement = false;
    let mut turn_finished = None;
    let mut turn_finished_status = None;

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .expect("read event stream");
        if bytes == 0 {
            break;
        }
        stdout_bytes = stdout_bytes.saturating_add(bytes as u64);
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            malformed_event_lines = malformed_event_lines.saturating_add(1);
            continue;
        };
        stdout_event_lines = stdout_event_lines.saturating_add(1);
        let observed = Instant::now();
        match event["type"].as_str() {
            Some("turn_started") => {
                turn_started.get_or_insert(observed);
            }
            Some("text_delta") if event["text"].as_str().is_some_and(|text| !text.is_empty()) => {
                first_text.get_or_insert(observed);
            }
            Some("tool_started") => {
                tool_started.get_or_insert(observed);
            }
            Some("tool_finished") => {
                tool_finished = Some(observed);
                successful_list_settlement = event["settlement"]["tool"] == "list"
                    && event["settlement"]["status"] == "success";
            }
            Some("turn_finished") => {
                turn_finished = Some(observed);
                turn_finished_status = event["status"].as_str().map(str::to_owned);
            }
            _ => continue,
        }
    }

    let status = child.wait().await.expect("wait for HorizonCode CLI");
    if let Some(sampler) = sampler {
        sampler.abort();
        let _ = sampler.await;
    }
    let stderr_bytes = stderr_reader
        .await
        .expect("join stderr reader")
        .expect("read stderr");
    let process_exit = Instant::now();
    assert!(
        status.success(),
        "headless sample failed: {status}; stderr had {stderr_bytes} bytes"
    );
    assert_eq!(malformed_event_lines, 0, "CLI emitted malformed NDJSON");
    assert!(turn_started.is_some(), "CLI did not emit turn_started");
    turn_finished.expect("CLI did not emit turn_finished");
    assert_eq!(
        turn_finished_status.as_deref(),
        Some("completed"),
        "the diagnostic must measure a completed turn"
    );
    if workload == "text" {
        assert!(
            first_text.is_some(),
            "text fixture did not produce a text_delta"
        );
    } else {
        assert!(
            tool_started.is_some(),
            "tool fixture did not execute the list tool"
        );
        assert!(
            tool_finished.is_some(),
            "tool fixture did not settle the list tool"
        );
        assert!(
            successful_list_settlement,
            "the list fixture must settle successfully"
        );
    }

    let arrivals = server.request_arrivals();
    let response_starts = server.response_starts();
    let dispatch = arrivals.get(request_index).copied();
    let first_text_response_index = request_index + usize::from(workload == "list-tool");
    let response_start = response_starts.get(first_text_response_index).copied();
    assert!(
        dispatch.is_some(),
        "mock did not observe request {request_index}"
    );
    let elapsed_ns = |end: Option<Instant>| {
        end.and_then(|instant| instant.checked_duration_since(started))
            .map(duration_ns)
    };
    let response_to_text_ns = response_start
        .zip(first_text)
        .and_then(|(response, text)| text.checked_duration_since(response))
        .map(duration_ns);

    Sample {
        workload,
        cache_state,
        exit_code: status.code(),
        spawn_to_turn_started_ns: elapsed_ns(turn_started),
        spawn_to_dispatch_ns: dispatch
            .and_then(|instant| instant.checked_duration_since(started))
            .map(duration_ns),
        fixture_response_start_to_first_text_event_ns: response_to_text_ns,
        spawn_to_first_text_event_ns: elapsed_ns(first_text),
        tool_started_to_tool_finished_ns: tool_started
            .zip(tool_finished)
            .and_then(|(start, end)| end.checked_duration_since(start))
            .map(duration_ns),
        spawn_to_turn_finished_ns: elapsed_ns(turn_finished),
        spawn_to_process_exit_ns: duration_ns(process_exit.duration_since(started)),
        sampled_peak_rss_bytes: match rss_peak.load(Ordering::Relaxed) {
            0 => None,
            bytes => Some(bytes),
        },
        stdout_bytes,
        stdout_event_lines,
        malformed_event_lines,
        stderr_bytes: stderr_bytes as u64,
    }
}

fn duration_ns(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn percentile(values: &[u64], quantile: f64) -> Option<u64> {
    if values.is_empty() || !(0.0..=1.0).contains(&quantile) {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = (quantile * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted.get(rank - 1).copied()
}

fn summarize(values: impl Iterator<Item = u64>) -> Value {
    let values: Vec<u64> = values.collect();
    json!({
        "sample_count": values.len(),
        "min": values.iter().min(),
        "p50_nearest_rank": percentile(&values, 0.50),
        "p95_nearest_rank": percentile(&values, 0.95),
        "max": values.iter().max()
    })
}

fn workspace_root() -> PathBuf {
    std::env::current_dir()
        .expect("read current directory")
        .ancestors()
        .find(|path| path.join("ARCH/contracts/PERFORMANCE.md").is_file())
        .expect("run this test from the HorizonCode workspace")
        .to_owned()
}

fn git_text(root: &Path, args: &[&str]) -> Option<String> {
    let output = StdCommand::new("git")
        .args(["-C"])
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn source_tree_digest(root: &Path) -> String {
    fn visit(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                if entry.file_name() != "target" {
                    visit(&path, files)?;
                }
            } else if file_type.is_file()
                && (path.extension().is_some_and(|extension| extension == "rs")
                    || path.file_name().is_some_and(|name| name == "Cargo.toml"))
            {
                files.push(path);
            }
        }
        Ok(())
    }

    let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock")];
    visit(&root.join("crates"), &mut files).expect("walk Rust sources");
    files.sort();
    let mut hasher = blake3::Hasher::new();
    for path in files {
        let relative = path.strip_prefix(root).expect("source is inside workspace");
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(&[0]);
        hasher.update(&fs::read(path).expect("read source file"));
        hasher.update(&[0]);
    }
    hasher.finalize().to_hex().to_string()
}

fn file_digest(path: &Path) -> String {
    let bytes = fs::read(path).expect("read file required for evidence binding");
    blake3::hash(&bytes).to_hex().to_string()
}

fn command_version(program: &str, args: &[&str]) -> Option<String> {
    let output = StdCommand::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn machine_details() -> Value {
    let kernel = StdCommand::new("uname")
        .args(["-sr"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    let cpu_model = fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|contents| {
            contents.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                matches!(key.trim(), "model name" | "Hardware").then(|| value.trim().to_owned())
            })
        });
    let load_1m = fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|contents| contents.split_whitespace().next()?.parse::<f64>().ok());
    json!({
        "os": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "kernel": kernel,
        "cpu_model": cpu_model,
        "logical_cpu_count": std::thread::available_parallelism().ok().map(usize::from),
        "load_average_1m_before_capture": load_1m,
        "reference_machine_accepted": false
    })
}

fn process_rss_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        rss_bytes_from_proc_status(&status)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

fn rss_bytes_from_proc_status(status: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key != "VmRSS" {
            return None;
        }
        let kib = value.split_whitespace().next()?.parse::<u64>().ok()?;
        Some(kib.saturating_mul(1024))
    })
}
