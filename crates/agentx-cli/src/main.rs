//! The `agentx` binary entry point.

mod app;
mod approval;
mod args;
mod output;
mod surfaces;

use std::process::ExitCode;

use clap::Parser;

use crate::app::{EXIT_CONFIG, EXIT_INTERNAL, is_config_error};

fn main() -> ExitCode {
    let args = args::Cli::parse();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("agentx: failed to start the async runtime: {error}");
            return ExitCode::from(EXIT_INTERNAL);
        }
    };

    let result = runtime.block_on(app::run(args));
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if is_config_error(&error) {
                eprintln!("agentx: configuration error: {error}");
                ExitCode::from(EXIT_CONFIG)
            } else {
                eprintln!("agentx: {error}");
                ExitCode::from(EXIT_INTERNAL)
            }
        }
    }
}
