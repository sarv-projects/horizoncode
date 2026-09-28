//! The `horizoncode` binary entry point.

mod app;
mod approval;
mod args;
mod output;
mod surfaces;

use std::process::ExitCode;

use clap::Parser;

use crate::app::{EXIT_ACCESS_FAILED, EXIT_CONFIG, EXIT_INTERNAL, is_config_error};

fn main() -> ExitCode {
    let args = args::Cli::parse();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("horizoncode: failed to start the async runtime: {error}");
            return ExitCode::from(EXIT_INTERNAL);
        }
    };

    let result = runtime.block_on(app::run(args));
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if is_config_error(&error) {
                eprintln!("horizoncode: configuration error: {error}");
                ExitCode::from(EXIT_CONFIG)
            } else if matches!(error, crate::app::CliError::Access(_)) {
                // The evidence was not disclosed because the record of the
                // disclosure could not be written; that is its own outcome, not
                // an internal error and not a bad-evidence verdict.
                eprintln!("horizoncode: {error}");
                ExitCode::from(EXIT_ACCESS_FAILED)
            } else {
                eprintln!("horizoncode: {error}");
                ExitCode::from(EXIT_INTERNAL)
            }
        }
    }
}
