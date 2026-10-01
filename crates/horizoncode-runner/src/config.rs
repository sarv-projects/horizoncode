//! Loop configuration.

use std::path::PathBuf;
use std::sync::Arc;

use horizoncode_sandbox::{ResolvedProfile, SandboxProvider};
use horizoncode_tools::OutputBounds;

use crate::recorder::Recorder;

/// Version of the default per-response admission ceilings.
pub const RESPONSE_LIMITS_VERSION: u16 = 1;
/// Default maximum tool calls in one model response.
pub const DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE: usize = 32;
/// Default aggregate streamed tool-argument ceiling (256 KiB).
pub const DEFAULT_MAX_TOOL_ARGUMENT_BYTES_PER_RESPONSE: usize = 256 * 1024;
/// Default retained model-response ceiling (4 MiB).
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

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
    /// Maximum distinct tool calls admitted from one complete response.
    pub max_tool_calls_per_response: usize,
    /// Maximum aggregate streamed tool-argument bytes in one response.
    pub max_tool_argument_bytes_per_response: usize,
    /// Maximum aggregate retained response bytes (text, reasoning, and call data).
    pub max_response_bytes: usize,
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
    /// The confinement backend used for shell effects.
    pub sandbox: Option<Arc<dyn SandboxProvider>>,
    /// The resolved confinement plan matching `sandbox`.
    pub sandbox_resolved: Option<Arc<ResolvedProfile>>,
    /// The optional audit and analytics sinks the loop records into.
    pub recorder: Recorder,
    /// The advertised context-window size, when the deployment declares one.
    ///
    /// A surface that renders a context-window figure must not invent it: with
    /// no declared window, no window is rendered.
    pub context_window: Option<u64>,
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
            max_tool_calls_per_response: DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
            max_tool_argument_bytes_per_response: DEFAULT_MAX_TOOL_ARGUMENT_BYTES_PER_RESPONSE,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            system: Vec::new(),
            output_bounds: OutputBounds::default(),
            max_parallel_tools: 8,
            token_budget: None,
            temperature: None,
            max_output_tokens: None,
            sandbox: None,
            sandbox_resolved: None,
            recorder: Recorder::default(),
            context_window: None,
        }
    }
}
