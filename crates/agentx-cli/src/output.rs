//! Headless run observers: human-readable and NDJSON event streaming.

use std::io::Write;

use agentx_runner::{RunEvent, RunObserver};
use agentx_types::ToolStatus;

use crate::args::OutputFormat;

/// Renders run events for a headless surface.
#[derive(Debug)]
pub struct CliObserver {
    format: OutputFormat,
}

impl CliObserver {
    /// Builds an observer for the requested format.
    #[must_use]
    pub fn new(format: OutputFormat) -> Self {
        Self { format }
    }
}

impl RunObserver for CliObserver {
    fn on_event(&mut self, event: RunEvent) {
        match self.format {
            OutputFormat::Json | OutputFormat::Ndjson => {
                if let Ok(line) = serde_json::to_string(&event) {
                    let stdout = std::io::stdout();
                    let mut lock = stdout.lock();
                    let _ = writeln!(lock, "{line}");
                    let _ = lock.flush();
                }
            }
            OutputFormat::Default => match event {
                RunEvent::TextDelta { text } => {
                    let stdout = std::io::stdout();
                    let mut lock = stdout.lock();
                    let _ = write!(lock, "{text}");
                    let _ = lock.flush();
                }
                RunEvent::ToolStarted { tool_call, .. } => {
                    eprintln!("[tool] {} started", tool_call.name);
                }
                RunEvent::ToolFinished { settlement } => {
                    let label = match settlement.status {
                        ToolStatus::Success => "ok",
                        ToolStatus::Error => "error",
                        ToolStatus::Denied => "denied",
                        ToolStatus::Aborted => "aborted",
                    };
                    eprintln!("[tool] {} {label}", settlement.tool);
                }
                RunEvent::TurnFinished { status, reason, .. } => {
                    eprintln!("[turn] {} ({reason})", status.as_str());
                }
                _ => {}
            },
        }
    }
}
