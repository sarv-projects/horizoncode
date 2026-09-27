//! The audit and analytics subcommand surfaces.
//!
//! These read the stores directly and need no provider configuration, so they
//! work when a run is not possible. Every failure is a **distinct** exit code:
//! a failed `audit verify` or a census gap is `6`, never `0` and never a generic
//! internal error, so a gate can tell "the evidence is bad" from "the tool
//! broke" (`G-5`).

use std::io::Write;
use std::path::PathBuf;

use agentx_analytics::{AnalyticsConfig, AnalyticsLog, insights, usage};
use agentx_audit::{
    AnchorLevelName, AuditConfig, CensusWindow, ReplayWindow, census, census_strict, replay,
    verify, write_artifact,
};
use serde::Serialize;

use crate::app::CliError;
use crate::app::{EXIT_AUDIT_FAILED, EXIT_SUCCESS, StateDir};
use crate::args::{AnalyticsCommand, AuditCommand, OutputFormat};

/// Runs an `audit` subcommand.
pub fn run_audit(state: &StateDir, command: &AuditCommand) -> Result<u8, CliError> {
    let config = audit_config(state);
    match command {
        AuditCommand::Verify { session, all } => {
            if session.is_none() && !all {
                return Err(CliError::Config(
                    "audit verify needs --session <id> or --all".to_owned(),
                ));
            }
            run_verify(&config, session.as_deref(), *all)
        }
        AuditCommand::Replay { session, from, to } => run_replay(&config, session, *from, *to),
        AuditCommand::Census {
            session,
            out,
            allow_uncovered,
        } => run_census(&config, session.as_deref(), out.as_ref(), *allow_uncovered),
    }
}

/// Runs an `analytics` subcommand.
pub fn run_analytics(state: &StateDir, command: &AnalyticsCommand) -> Result<u8, CliError> {
    let config = AnalyticsConfig::new(state.analytics_root());
    match command {
        AnalyticsCommand::Stats { session, format } => {
            let report = usage(&config, session.as_deref()).map_err(analytics_error)?;
            match format {
                OutputFormat::Default => print(&report.render()),
                OutputFormat::Json | OutputFormat::Ndjson => {
                    print(&to_json(&report)?);
                }
            }
            Ok(EXIT_SUCCESS)
        }
        AnalyticsCommand::Export { sanitize } => {
            let log = AnalyticsLog::open(config).map_err(analytics_error)?;
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();
            log.export(&mut handle, *sanitize)
                .map_err(analytics_error)?;
            let _ = handle.flush();
            Ok(EXIT_SUCCESS)
        }
    }
}

/// Renders `/usage` from a prompt-shaped invocation.
///
/// The command works with no provider configuration, which is what makes it
/// usable when a run is not possible.
pub fn run_usage(state: &StateDir, session: Option<&str>) -> Result<u8, CliError> {
    let config = AnalyticsConfig::new(state.analytics_root());
    let report = usage(&config, session).map_err(analytics_error)?;
    print(&report.render());
    Ok(EXIT_SUCCESS)
}

/// Renders `/insights [--days N]` from a prompt-shaped invocation.
pub fn run_insights(state: &StateDir, days: Option<u32>) -> Result<u8, CliError> {
    let config = AnalyticsConfig::new(state.analytics_root());
    let days = days.unwrap_or(7);
    let report = insights(&config, days).map_err(analytics_error)?;
    print(&report.render());
    Ok(EXIT_SUCCESS)
}

fn run_verify(config: &AuditConfig, session: Option<&str>, all: bool) -> Result<u8, CliError> {
    note_access(config, "audit_verify", session.or(Some("all")));
    let report = match verify(config) {
        Ok(report) => report,
        Err(error) => {
            // A divergence is the tool working correctly: it found the problem.
            // It is reported on stderr and given its own exit code.
            eprintln!("agentx: audit verification FAILED");
            eprintln!("agentx: first divergence: {error}");
            eprint_claim_boundary();
            return Ok(EXIT_AUDIT_FAILED);
        }
    };
    if let Some(session) = session
        && !all
    {
        // The chain is global; a session filter narrows what is *reported*.
        let replay = replay(config, Some(session), ReplayWindow::default());
        match replay {
            Ok(report) => print(&report.render()),
            Err(error) => eprintln!("agentx: audit replay failed: {error}"),
        }
    }
    print(&report.render_claim());
    println!("entries verified: {}", report.entries_checked);
    println!("segment roots verified: {}", report.roots_checked);
    println!("anchored roots: {}", report.anchored_roots);
    for segment in &report.segments {
        println!(
            "  segment {}: seq {}..={} count={} sealed={} anchored={} signature_ok={}",
            segment.segment,
            segment.first_seq,
            segment.last_seq,
            segment.count,
            segment.sealed,
            segment.anchored,
            segment.signature_ok
        );
    }
    Ok(EXIT_SUCCESS)
}

fn run_replay(
    config: &AuditConfig,
    session: &str,
    from: Option<u64>,
    to: Option<u64>,
) -> Result<u8, CliError> {
    note_access(config, "audit_replay", Some(session));
    match replay(config, Some(session), ReplayWindow::between(from, to)) {
        Ok(report) => {
            print(&report.render());
            Ok(EXIT_SUCCESS)
        }
        Err(error) => {
            eprintln!("agentx: audit replay FAILED: {error}");
            Ok(EXIT_AUDIT_FAILED)
        }
    }
}

fn run_census(
    config: &AuditConfig,
    session: Option<&str>,
    out: Option<&PathBuf>,
    allow_uncovered: bool,
) -> Result<u8, CliError> {
    let window = match session {
        Some(session) => CensusWindow::for_session(session.to_owned()),
        None => CensusWindow::all(),
    };
    // Reading the record is itself security-relevant access, so the access is
    // recorded before the census reads it.
    note_access(config, "audit_census", session);
    // Strict by default: an uncovered declared class, or a recorded effect
    // outside the registry, is a defect and fails the command.
    let report = match census_strict(config, window.clone()) {
        Ok(report) => report,
        Err(error) => {
            if !allow_uncovered {
                eprintln!("agentx: coverage census FAILED: {error}");
                return Ok(EXIT_AUDIT_FAILED);
            }
            eprintln!("agentx: coverage census reported a gap: {error}");
            census(config, window.clone()).map_err(audit_error)?
        }
    };
    if let Some(path) = out {
        match write_artifact(config, window, path) {
            Ok(_) => println!("census artifact written: {}", path.display()),
            Err(error) => {
                eprintln!("agentx: census artifact failed: {error}");
                return Ok(EXIT_AUDIT_FAILED);
            }
        }
    }
    println!(
        "coverage census: {} entries across {} segment(s)",
        report.entries_examined, report.segments_examined
    );
    for class in &report.classes {
        let evidence = match class.first_seq {
            Some(_) => format!(
                "seq {}..={}",
                class.first_seq.unwrap_or(0),
                class.last_seq.unwrap_or(0)
            ),
            None => "UNCOVERED".to_owned(),
        };
        println!(
            "  {:<22} count={:<4} {evidence}",
            class.class.as_str(),
            class.count
        );
    }
    println!("anchoring level: {}", report.level.as_str());
    if !report.uncovered.is_empty() {
        let names: Vec<&str> = report
            .uncovered
            .iter()
            .map(|class| class.as_str())
            .collect();
        println!("UNCOVERED declared classes: {}", names.join(", "));
    }
    Ok(EXIT_SUCCESS)
}

/// Records that this surface read the audit record.
///
/// A write failure is reported but does not fail the read: the caller is
/// inspecting evidence, and refusing to show it because the *access* could not be
/// noted would be worse than showing it with the note missing.
fn note_access(config: &AuditConfig, action: &str, resource: Option<&str>) {
    let env: Vec<(String, String)> = std::env::vars().collect();
    match agentx_audit::AuditLog::open(config.clone(), &env) {
        Ok(log) => {
            if let Err(error) = log.note_access(action, resource.unwrap_or("-")) {
                eprintln!("agentx: audit access note failed: {error}");
            }
        }
        Err(error) => eprintln!("agentx: audit access note could not be written: {error}"),
    }
}

fn print(text: &str) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(text.as_bytes());
    let _ = handle.flush();
}

fn to_json<T: Serialize>(value: &T) -> Result<String, CliError> {
    serde_json::to_string_pretty(value)
        .map_err(|error| CliError::Config(format!("failed to render json: {error}")))
}

fn eprint_claim_boundary() {
    let boundary = agentx_audit::claim_boundary(AnchorLevelName::LocalSink, None);
    eprintln!("agentx: claim boundary at local-sink:");
    for line in &boundary.does_not_detect {
        eprintln!("  does NOT detect: {line}");
    }
}

fn audit_error(error: agentx_audit::AuditError) -> CliError {
    CliError::Audit(error.to_string())
}

fn analytics_error(error: agentx_analytics::AnalyticsError) -> CliError {
    CliError::Analytics(error.to_string())
}

fn audit_config(state: &StateDir) -> AuditConfig {
    AuditConfig::new(state.audit_root())
}
