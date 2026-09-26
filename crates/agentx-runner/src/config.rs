//! Loop configuration.

use std::path::PathBuf;

use agentx_tools::OutputBounds;

/// Configuration for one runner instance.
#[derive(Clone, Debug)]
pub struct RunConfig {
    /// The model id sent to the provider.
    pub model: String,
    /// The provider/route id recorded on the session.
    pub provider: String,
    /// The interaction mode recorded on the session.
    pub mode: String,
    /// The workspace root path-scoped tools resolve within.
    pub workspace: PathBuf,
    /// Optional directory for spilled tool output.
    pub output_dir: Option<PathBuf>,
    /// The maximum number of model steps per turn (`REQ-LOOP-001`).
    pub max_steps: usize,
    /// Static system instructions.
    pub system: Vec<String>,
    /// Model-visible output bounds applied at settlement.
    pub output_bounds: OutputBounds,
    /// Maximum independent tool calls executed concurrently.
    pub max_parallel_tools: usize,
    /// Optional per-session token ceiling; exhaustion fails closed.
    pub token_budget: Option<u64>,
    /// Optional sampling temperature.
    pub temperature: Option<f32>,
    /// Optional output-token ceiling.
    pub max_output_tokens: Option<u32>,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            model: "default".to_owned(),
            provider: "compatible".to_owned(),
            mode: "chat".to_owned(),
            workspace: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            output_dir: None,
            max_steps: 25,
            system: Vec::new(),
            output_bounds: OutputBounds::default(),
            max_parallel_tools: 8,
            token_budget: None,
            temperature: None,
            max_output_tokens: None,
        }
    }
}
