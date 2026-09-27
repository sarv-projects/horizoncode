//! Shared test support for the CLI end-to-end tests.
//!
//! ## Why this module exists
//!
//! Every CLI test needs a private state root, because `AGENTX_HOME` decides
//! where the session log, the audit store, the anchor sink, and the analytics
//! ledger live. Getting that wrong is not a cosmetic bug:
//!
//! - a helper that **caches** a resolved home in a process global makes the
//!   suite **order-dependent** — the first test to run decides what every later
//!   test in that binary sees, so a bare `cargo test -p agentx-cli` can behave
//!   differently from a workspace run;
//! - a helper that **probes writability by writing** and then caches the
//!   result can bake an *unwritable* home into that global, and a later
//!   end-to-end run in the same process then fails for a reason that has
//!   nothing to do with what it is testing;
//! - a helper that falls back to the developer's real `~/.agentx` writes test
//!   state into their account.
//!
//! [`TestHome`] has none of those properties: it creates a **fresh** temp root
//! per instance, holds no process-global state at all, and never probes
//! writability by writing. Writability is established by construction — a
//! `tempfile::TempDir` is created, so the root exists and is writable by
//! definition — and is not cached anywhere.
//!
//! `test_homes_are_independent_and_leave_no_global_state` pins these properties
//! so a future refactor cannot quietly reintroduce the coupling.

// A shared test helper is used by several test binaries, each of which needs a
// different part of it. `dead_code` would fire per binary rather than once.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use tokio::process::Command as AsyncCommand;

use agentx_provider::testing::{MockServer, MockTurn};

/// A private `AGENTX_HOME` for one test, plus the provider settings a run needs.
pub struct TestHome {
    dir: tempfile::TempDir,
}

impl TestHome {
    /// Creates a fresh, empty, writable state root.
    #[must_use]
    pub fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("a temp state root"),
        }
    }

    /// The state root to hand to the binary as `AGENTX_HOME`.
    #[must_use]
    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// The session log root under this home.
    #[must_use]
    pub fn sessions(&self) -> PathBuf {
        self.path().join("sessions")
    }

    /// The audit store root under this home.
    #[must_use]
    pub fn audit(&self) -> PathBuf {
        self.path().join("audit")
    }

    /// The analytics root under this home.
    #[must_use]
    pub fn analytics(&self) -> PathBuf {
        self.path().join("analytics")
    }

    /// A workspace temp root paired with this home.
    #[must_use]
    pub fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("a temp workspace")
    }

    /// Applies the environment a headless run needs.
    ///
    /// `AGENTX_HOME` is always set explicitly, and the provider variables are
    /// always set explicitly, so a run cannot pick up an ambient value from the
    /// developer's shell.
    #[must_use]
    pub fn env(&self, server: &MockServer) -> AsyncCommand {
        let mut command = AsyncCommand::new(env!("CARGO_BIN_EXE_agentx"));
        command
            .env("AGENTX_BASE_URL", server.base_url())
            .env("AGENTX_API_KEY", "test-key")
            .env("AGENTX_MODEL", "mock-model")
            .env("AGENTX_HOME", self.path());
        command
    }

    /// Applies an environment that needs **no** provider configuration, for the
    /// inspection surfaces.
    #[must_use]
    pub fn env_offline(&self) -> AsyncCommand {
        let mut command = AsyncCommand::new(env!("CARGO_BIN_EXE_agentx"));
        command
            .env_remove("AGENTX_BASE_URL")
            .env_remove("AGENTX_API_KEY")
            .env("AGENTX_HOME", self.path());
        command
    }

    /// Runs a one-shot prompt against `server` in `workspace`.
    pub async fn run(&self, server: &MockServer, workspace: &Path, prompt: &str) -> Output {
        self.env(server)
            .args(["-p", prompt, "--cwd", workspace.to_str().unwrap()])
            .output()
            .await
            .expect("the agentx binary must be runnable")
    }
}

/// A completed process.
pub type Output = std::process::Output;

/// A scripted provider that answers with one text turn.
pub async fn text_server(text: &str) -> MockServer {
    MockServer::start(vec![MockTurn::text(text)]).await
}
