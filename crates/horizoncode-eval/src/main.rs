//! `hz-eval` command entry point.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use horizoncode_eval::{RecordError, validate_bytes};

#[derive(Debug, Parser)]
#[command(name = "hz-eval", about = "Validate HorizonCode evaluation records")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate one bounded, integrity-sealed EvaluationRunV1 JSON record.
    Validate {
        /// Path to the evaluation record.
        record: PathBuf,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("hz-eval: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Validate { record } => {
            let file = std::fs::File::open(&record)
                .map_err(|_| "cannot open evaluation record".to_owned())?;
            let mut bytes = Vec::new();
            file.take((horizoncode_eval::MAX_RECORD_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read evaluation record".to_owned())?;
            let validated = validate_bytes(&bytes).map_err(|error| match error {
                RecordError::TooLarge => {
                    "evaluation record exceeds the 1 MiB input limit".to_owned()
                }
                RecordError::InvalidSchema | RecordError::Invalid => {
                    "evaluation record failed schema or integrity validation".to_owned()
                }
            })?;
            println!("valid EvaluationRunV1: {}", validated.evaluation_id);
            Ok(())
        }
    }
}
