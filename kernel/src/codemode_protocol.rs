//! Strict bounded JSON frames for the private CodeMode helper stdio channel.
//!
//! These frames carry no authority. The helper can request a complete nested wave,
//! but Core admits it through the existing SessionSupervisor and Guard path. A
//! `completed` frame describes helper execution only and never settles an effect.

use serde::{Deserialize, Serialize};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserializer};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 65_536;
pub const MAX_CALLS_PER_WAVE: usize = 32;
pub const MAX_CALL_ARGUMENT_BYTES: usize = 262_144;
pub const MAX_WAVE_ARGUMENT_BYTES: usize = 524_288;
pub const MAX_TOTAL_ARGUMENT_BYTES: usize = 1_048_576;
pub const MAX_TOOL_DEFINITION_BYTES: usize = 1_048_576;
pub const MAX_TOTAL_CALLS: usize = 64;
pub const MAX_OUTPUT_BYTES: usize = 65_536;

pub type JsonMap = BTreeMap<String, serde_json::Value>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeToolV1 {
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "capabilityId")]
    pub capability_id: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: JsonMap,
    #[serde(rename = "inputSchemaDigest")]
    pub input_schema_digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeCallV1 {
    #[serde(rename = "callId")]
    pub call_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "capabilityId")]
    pub capability_id: String,
    pub arguments: JsonMap,
    #[serde(rename = "argumentBytes")]
    pub argument_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeCallResultV1 {
    #[serde(rename = "callId")]
    pub call_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(rename = "resultDigest", skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(rename = "outputBytes", skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<usize>,
    #[serde(rename = "receiptRef", skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
    #[serde(rename = "receiptKind", skip_serializing_if = "Option::is_none")]
    pub receipt_kind: Option<String>,
    #[serde(rename = "receiptDigest", skip_serializing_if = "Option::is_none")]
    pub receipt_digest: Option<String>,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeStartV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "frameType")]
    pub frame_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: String,
    pub code: String,
    #[serde(rename = "toolSetDigest")]
    pub tool_set_digest: String,
    #[serde(rename = "toolDefinitionsBytes")]
    pub tool_definitions_bytes: usize,
    pub tools: Vec<CodeModeToolV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeWaveRequestV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "frameType")]
    pub frame_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: String,
    #[serde(rename = "waveIndex")]
    pub wave_index: u8,
    pub calls: Vec<CodeModeCallV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeWaveResultV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "frameType")]
    pub frame_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: String,
    #[serde(rename = "waveIndex")]
    pub wave_index: u8,
    #[serde(rename = "batchId")]
    pub batch_id: String,
    pub status: String,
    pub results: Vec<CodeModeCallResultV1>,
    #[serde(rename = "receiptDigest", skip_serializing_if = "Option::is_none")]
    pub receipt_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeCancelV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "frameType")]
    pub frame_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeModeCompletedV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "frameType")]
    pub frame_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodeModeFrameV1 {
    Start(CodeModeStartV1),
    WaveRequest(CodeModeWaveRequestV1),
    WaveResult(CodeModeWaveResultV1),
    Cancel(CodeModeCancelV1),
    Completed(CodeModeCompletedV1),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodeModeFrameErrorV1 {
    Invalid,
    Oversized,
}

impl CodeModeFrameV1 {
    /// Decode exactly one UTF-8 JSON line, reject unknown fields, then recompute
    /// argument byte counts and validate the complete frame's bounded shape.
    pub fn from_json_line(bytes: &[u8]) -> Result<Self, CodeModeFrameErrorV1> {
        if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES { return Err(CodeModeFrameErrorV1::Oversized); }
        let line = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        if line.is_empty() || line.iter().any(|byte| matches!(byte, b'\n' | b'\r')) {
            return Err(CodeModeFrameErrorV1::Invalid);
        }
        let value = StrictJson::deserialize(&mut serde_json::Deserializer::from_slice(line))
            .map_err(|_| CodeModeFrameErrorV1::Invalid)?.0;
        let frame_type = value.as_object().and_then(|map| map.get("frameType"))
            .and_then(serde_json::Value::as_str).ok_or(CodeModeFrameErrorV1::Invalid)?;
        let frame = match frame_type {
            "start" => Self::Start(decode_strict(value)?),
            "wave_request" => Self::WaveRequest(decode_strict(value)?),
            "wave_result" => Self::WaveResult(decode_strict(value)?),
            "cancel" => Self::Cancel(decode_strict(value)?),
            "completed" => Self::Completed(decode_strict(value)?),
            _ => return Err(CodeModeFrameErrorV1::Invalid),
        };
        frame.validate()?;
        Ok(frame)
    }

    pub fn to_json_line(&self) -> Result<Vec<u8>, CodeModeFrameErrorV1> {
        self.validate()?;
        let mut bytes = match self {
            Self::Start(frame) => serde_json::to_vec(frame),
            Self::WaveRequest(frame) => serde_json::to_vec(frame),
            Self::WaveResult(frame) => serde_json::to_vec(frame),
            Self::Cancel(frame) => serde_json::to_vec(frame),
            Self::Completed(frame) => serde_json::to_vec(frame),
        }.map_err(|_| CodeModeFrameErrorV1::Invalid)?;
        if bytes.len().checked_add(1).is_none_or(|length| length > MAX_FRAME_BYTES) {
            return Err(CodeModeFrameErrorV1::Oversized);
        }
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn validate(&self) -> Result<(), CodeModeFrameErrorV1> {
        match self {
            Self::Start(frame) => {
                valid_envelope(frame.schema_version, &frame.frame_type, &frame.request_id, &frame.sequence, "start")?;
                if frame.sequence != "0" || frame.code.is_empty() || frame.code.len() > MAX_SOURCE_BYTES
                    || !valid_digest(&frame.tool_set_digest) || frame.tools.len() > 256
                    || frame.tools.iter().any(|tool| !valid_id(&tool.tool_name) || !valid_id(&tool.capability_id)
                    || tool.description.len() > 4096 || tool.input_schema.len() > 256
                    || !valid_json_value(&serde_json::Value::Object(tool.input_schema.clone().into_iter().collect()))
                    || tool.input_schema_digest != schema_digest(&tool.input_schema).unwrap_or_default())
                    || frame.tools.iter().map(|tool| tool.tool_name.as_str()).collect::<HashSet<_>>().len() != frame.tools.len()
                    || frame.tools.windows(2).any(|pair| (&pair[0].capability_id, &pair[0].tool_name) >= (&pair[1].capability_id, &pair[1].tool_name))
                    || frame.tool_set_digest != tool_set_digest(&frame.tools).unwrap_or_default()
                    || canonical_tool_definitions_bytes(&frame.tools).ok() != Some(frame.tool_definitions_bytes)
                    || frame.tool_definitions_bytes > MAX_TOOL_DEFINITION_BYTES
                { return Err(CodeModeFrameErrorV1::Invalid); }
            }
            Self::WaveRequest(frame) => {
                valid_envelope(frame.schema_version, &frame.frame_type, &frame.request_id, &frame.sequence, "wave_request")?;
                if frame.wave_index > 63 || frame.calls.is_empty() || frame.calls.len() > MAX_CALLS_PER_WAVE
                    || frame.calls.iter().any(|call| !valid_id(&call.call_id) || !valid_id(&call.tool_name)
                        || !valid_id(&call.capability_id) || !valid_argument_map(&call.arguments)
                        || canonical_json_argument_bytes(&call.arguments).ok() != Some(call.argument_bytes)
                        || call.argument_bytes > MAX_CALL_ARGUMENT_BYTES)
                    || frame.calls.iter().map(|call| call.call_id.as_str()).collect::<HashSet<_>>().len() != frame.calls.len()
                    || frame.calls.iter().fold(0usize, |sum, call| sum.saturating_add(call.argument_bytes)) > MAX_WAVE_ARGUMENT_BYTES
                { return Err(CodeModeFrameErrorV1::Invalid); }
            }
            Self::WaveResult(frame) => {
                valid_envelope(frame.schema_version, &frame.frame_type, &frame.request_id, &frame.sequence, "wave_result")?;
                if frame.wave_index > 63 || !valid_id(&frame.batch_id) || frame.results.len() > MAX_CALLS_PER_WAVE
                    || !matches!(frame.status.as_str(), "settled" | "rejected" | "cancelled" | "unknown")
                    || frame.results.iter().any(|result| !valid_id(&result.call_id)
                        || !matches!(result.status.as_str(), "settled" | "rejected" | "cancelled" | "unknown")
                        || result.output.as_ref().is_some_and(|output| output.len() > MAX_OUTPUT_BYTES)
                        || result.result_digest.as_ref().is_some_and(|digest| !digest.starts_with("blake3:") || !valid_digest(digest))
                        || result.output_bytes.is_some_and(|bytes| bytes > MAX_OUTPUT_BYTES)
                        || result.receipt_ref.as_ref().is_some_and(|value| !valid_id(value))
                        || result.receipt_digest.as_ref().is_some_and(|value| !valid_digest(value))
                        || result.error_code.as_ref().is_some_and(|value| value.len() > 128))
                    || frame.receipt_digest.as_ref().is_some_and(|value| !valid_digest(value))
                    || frame.results.iter().map(|row| row.call_id.as_str()).collect::<HashSet<_>>().len() != frame.results.len()
                { return Err(CodeModeFrameErrorV1::Invalid); }
                if frame.results.iter().any(|row| match row.status.as_str() {
                    "unknown" => row.receipt_ref.is_some() || row.receipt_kind.is_some() || row.receipt_digest.is_some()
                        || row.output.is_some() || row.result_digest.is_some() || row.output_bytes.is_some() || row.error_code.is_some(),
                    "settled" | "rejected" | "cancelled" => row.receipt_ref.is_none()
                        || row.receipt_kind.as_deref().is_none_or(|kind| !matches!(kind, "effect_receipt" | "host_decision" | "tool_result"))
                        || (row.receipt_kind.as_deref() == Some("host_decision") && (row.output.is_some() || row.result_digest.is_some() || row.output_bytes.is_some()))
                        || (row.receipt_kind.as_deref() == Some("effect_receipt") && (row.result_digest.is_some() || row.output_bytes.is_some()))
                        || (row.receipt_kind.as_deref() == Some("tool_result") && row.status == "settled"
                            && (row.output.is_none() || row.result_digest.as_deref() != row.output.as_deref().and_then(|output| codemode_tool_result_digest_v1(output).ok()).as_deref()
                                || row.output_bytes != row.output.as_ref().map(|output| output.as_bytes().len())))
                        || (row.receipt_kind.as_deref() == Some("tool_result") && row.status != "settled"
                            && (row.result_digest.is_some() || row.output_bytes.is_some() || row.error_code.is_none()))
                        || row.receipt_digest.as_deref().is_none_or(|value| !valid_digest(value)),
                    _ => true,
                })
                    || frame.results.iter().any(|row| row.receipt_ref.as_deref().is_some_and(str::is_empty))
                    || frame.status == "settled" && (frame.results.is_empty()
                        || frame.receipt_digest.is_none()
                        || frame.results.iter().any(|row| row.status != "settled"))
                    || frame.status == "rejected" && (frame.receipt_digest.is_none()
                        || frame.results.is_empty() || frame.results.iter().any(|row| row.status != "rejected"))
                    || frame.status == "cancelled" && (frame.receipt_digest.is_none()
                        || frame.results.is_empty() || frame.results.iter().any(|row| !matches!(row.status.as_str(), "settled" | "cancelled")))
                    || frame.status == "unknown" && (frame.receipt_digest.is_some()
                        || !frame.results.iter().any(|row| row.status == "unknown"))
                { return Err(CodeModeFrameErrorV1::Invalid); }
            }
            Self::Cancel(frame) => {
                valid_envelope(frame.schema_version, &frame.frame_type, &frame.request_id, &frame.sequence, "cancel")?;
                if !matches!(frame.reason.as_str(), "user_abort" | "deadline" | "parent_failure" | "shutdown") {
                    return Err(CodeModeFrameErrorV1::Invalid);
                }
            }
            Self::Completed(frame) => {
                valid_envelope(frame.schema_version, &frame.frame_type, &frame.request_id, &frame.sequence, "completed")?;
                if !matches!(frame.status.as_str(), "completed" | "failed" | "cancelled")
                    || frame.output.as_ref().is_some_and(|output| output.len() > MAX_OUTPUT_BYTES)
                    || frame.error_code.as_ref().is_some_and(|value| value.len() > 128)
                { return Err(CodeModeFrameErrorV1::Invalid); }
            }
        }
        Ok(())
    }
}

/// Stateful framing guard for one helper execution. Shape validation alone cannot
/// reject replayed sequences, duplicate call IDs across waves, skipped wave indexes,
/// or a completion frame arriving while a wave is still unsettled.
#[derive(Clone, Debug)]
pub(crate) struct CodeModeConversationV1 {
    request_id: String,
    allowed_tools: BTreeMap<String, String>,
    next_sequence: u64,
    next_wave: u8,
    total_calls: usize,
    total_argument_bytes: usize,
    total_output_bytes: usize,
    seen_call_ids: BTreeSet<String>,
    pending_wave: Option<u8>,
    pending_call_ids: BTreeSet<String>,
    pending_call_order: Vec<String>,
    terminal: bool,
    helper_completion_allowed: bool,
    helper_completion_status: Option<&'static str>,
}

impl CodeModeConversationV1 {
    pub(crate) fn start(frame: &CodeModeFrameV1) -> Result<Self, CodeModeFrameErrorV1> {
        frame.validate()?;
        let CodeModeFrameV1::Start(start) = frame else { return Err(CodeModeFrameErrorV1::Invalid) };
        let allowed_tools: BTreeMap<_, _> = start.tools.iter()
            .map(|tool| (tool.tool_name.clone(), tool.capability_id.clone())).collect();
        if allowed_tools.len() != start.tools.len() { return Err(CodeModeFrameErrorV1::Invalid); }
        Ok(Self {
            request_id: start.request_id.clone(),
            allowed_tools,
            next_sequence: 1,
            next_wave: 0,
            total_calls: 0,
            total_argument_bytes: 0,
            total_output_bytes: 0,
            seen_call_ids: BTreeSet::new(),
            pending_wave: None,
            pending_call_ids: BTreeSet::new(),
            pending_call_order: Vec::new(),
            terminal: false,
            helper_completion_allowed: false,
            helper_completion_status: None,
        })
    }

    /// Validate the next helper-originated frame and return a host response
    /// sequence when a wave must be answered. The caller must write a matching
    /// `wave_result` at that exact sequence before accepting another request.
    pub(crate) fn accept_helper_frame(
        &mut self,
        frame: &CodeModeFrameV1,
    ) -> Result<Option<u64>, CodeModeFrameErrorV1> {
        frame.validate()?;
        if self.pending_wave.is_some()
            || (self.terminal && !self.helper_completion_allowed)
        { return Err(CodeModeFrameErrorV1::Invalid); }
        let (request_id, sequence) = frame_identity_sequence(frame);
        if request_id != self.request_id || sequence != self.next_sequence { return Err(CodeModeFrameErrorV1::Invalid); }
        if self.helper_completion_allowed {
            let CodeModeFrameV1::Completed(completed) = frame else {
                return Err(CodeModeFrameErrorV1::Invalid);
            };
            if Some(completed.status.as_str()) != self.helper_completion_status {
                return Err(CodeModeFrameErrorV1::Invalid);
            }
            let output = completed.output.as_ref().map_or(0, String::len);
            let total = self.total_output_bytes.checked_add(output).ok_or(CodeModeFrameErrorV1::Invalid)?;
            if total > MAX_OUTPUT_BYTES { return Err(CodeModeFrameErrorV1::Invalid); }
            self.total_output_bytes = total;
            self.helper_completion_allowed = false;
            self.helper_completion_status = None;
            self.terminal = true;
            self.next_sequence = self.next_sequence.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
            return Ok(None);
        }
        match frame {
            CodeModeFrameV1::WaveRequest(request) => {
                if request.wave_index != self.next_wave { return Err(CodeModeFrameErrorV1::Invalid); }
                let new_total = self.total_calls.checked_add(request.calls.len()).ok_or(CodeModeFrameErrorV1::Invalid)?;
                let wave_argument_bytes = request.calls.iter().try_fold(0usize, |sum, call| {
                    sum.checked_add(call.argument_bytes)
                }).ok_or(CodeModeFrameErrorV1::Invalid)?;
                let new_argument_total = self.total_argument_bytes.checked_add(wave_argument_bytes)
                    .ok_or(CodeModeFrameErrorV1::Invalid)?;
                if wave_argument_bytes > MAX_WAVE_ARGUMENT_BYTES
                    || new_total > MAX_TOTAL_CALLS || request.calls.iter().any(|call|
                    self.allowed_tools.get(&call.tool_name) != Some(&call.capability_id)
                        || !self.seen_call_ids.insert(call.call_id.clone()))
                    || new_argument_total > MAX_TOTAL_ARGUMENT_BYTES {
                    return Err(CodeModeFrameErrorV1::Invalid);
                }
                self.total_calls = new_total;
                self.total_argument_bytes = new_argument_total;
                self.pending_wave = Some(request.wave_index);
                self.pending_call_ids = request.calls.iter().map(|call| call.call_id.clone()).collect();
                self.pending_call_order = request.calls.iter().map(|call| call.call_id.clone()).collect();
                self.next_sequence = self.next_sequence.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
                Ok(Some(self.next_sequence))
            }
            CodeModeFrameV1::Cancel(_) => {
                self.terminal = true;
                self.next_sequence = self.next_sequence.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
                Ok(None)
            }
            CodeModeFrameV1::Completed(completed) => {
                let output = completed.output.as_ref().map_or(0, String::len);
                let total = self.total_output_bytes.checked_add(output).ok_or(CodeModeFrameErrorV1::Invalid)?;
                if total > MAX_OUTPUT_BYTES { return Err(CodeModeFrameErrorV1::Invalid); }
                self.total_output_bytes = total;
                self.terminal = true;
                self.next_sequence = self.next_sequence.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
                Ok(None)
            }
            _ => Err(CodeModeFrameErrorV1::Invalid),
        }
    }

    pub(crate) fn accept_host_wave_result(
        &mut self,
        frame: &CodeModeFrameV1,
    ) -> Result<(), CodeModeFrameErrorV1> {
        frame.validate()?;
        let CodeModeFrameV1::WaveResult(result) = frame else { return Err(CodeModeFrameErrorV1::Invalid) };
        if self.terminal || result.request_id != self.request_id
            || result.sequence != self.next_sequence.to_string()
            || self.pending_wave != Some(result.wave_index)
            || result.results.len() != self.pending_call_ids.len()
            || result.results.iter().map(|row| row.call_id.as_str()).ne(self.pending_call_order.iter().map(String::as_str))
        { return Err(CodeModeFrameErrorV1::Invalid); }
        match result.status.as_str() {
            "settled" if result.results.iter().all(|row| row.status == "settled"
                && row.receipt_ref.is_some() && row.receipt_digest.is_some())
                && result.receipt_digest.is_some() => {}
            "unknown" if result.receipt_digest.is_none()
                && result.results.iter().all(|row| match row.status.as_str() {
                    "unknown" => row.receipt_ref.is_none() && row.receipt_kind.is_none() && row.receipt_digest.is_none(),
                    "settled" => row.receipt_ref.is_some() && row.receipt_kind.is_some() && row.receipt_digest.is_some(),
                    _ => false,
                }) => {}
            "rejected" if result.receipt_digest.is_some()
                && result.results.iter().all(|row| row.status == "rejected"
                    && row.receipt_ref.is_some() && row.receipt_digest.is_some()) => {}
            "cancelled" if result.receipt_digest.is_some()
                && result.results.iter().all(|row| matches!(row.status.as_str(), "settled" | "cancelled")
                    && row.receipt_ref.is_some() && row.receipt_digest.is_some()) => {}
            _ => return Err(CodeModeFrameErrorV1::Invalid),
        }
        if result.status != "unknown" {
            if result.receipt_digest.as_deref() != Some(codemode_public_wave_receipt_digest(
                result.wave_index, &result.results,
            )?.as_str()) {
                return Err(CodeModeFrameErrorV1::Invalid);
            }
        }
        let wave_output = result.results.iter().filter_map(|row| row.output.as_ref())
            .try_fold(0usize, |sum, output| sum.checked_add(output.len()))
            .ok_or(CodeModeFrameErrorV1::Invalid)?;
        let total_output = self.total_output_bytes.checked_add(wave_output)
            .ok_or(CodeModeFrameErrorV1::Invalid)?;
        if total_output > MAX_OUTPUT_BYTES { return Err(CodeModeFrameErrorV1::Invalid); }
        self.total_output_bytes = total_output;
        self.next_sequence = self.next_sequence.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
        if result.status == "unknown" {
            self.terminal = true;
            self.pending_wave = None;
            self.pending_call_ids.clear();
            self.pending_call_order.clear();
            return Ok(());
        }
        self.pending_wave = None;
        self.pending_call_ids.clear();
        self.pending_call_order.clear();
        if result.status == "rejected" || result.status == "cancelled" {
            self.terminal = true;
            self.helper_completion_allowed = true;
            self.helper_completion_status = Some(if result.status == "rejected" { "failed" } else { "cancelled" });
            return Ok(());
        }
        self.next_wave = self.next_wave.checked_add(1).ok_or(CodeModeFrameErrorV1::Invalid)?;
        Ok(())
    }
}

fn frame_identity_sequence(frame: &CodeModeFrameV1) -> (&str, u64) {
    match frame {
        CodeModeFrameV1::Start(value) => (&value.request_id, value.sequence.parse().unwrap_or(u64::MAX)),
        CodeModeFrameV1::WaveRequest(value) => (&value.request_id, value.sequence.parse().unwrap_or(u64::MAX)),
        CodeModeFrameV1::WaveResult(value) => (&value.request_id, value.sequence.parse().unwrap_or(u64::MAX)),
        CodeModeFrameV1::Cancel(value) => (&value.request_id, value.sequence.parse().unwrap_or(u64::MAX)),
        CodeModeFrameV1::Completed(value) => (&value.request_id, value.sequence.parse().unwrap_or(u64::MAX)),
    }
}

fn decode_strict<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, CodeModeFrameErrorV1> {
    serde_json::from_value(value).map_err(|_| CodeModeFrameErrorV1::Invalid)
}

fn valid_envelope(schema: u8, frame_type: &str, request_id: &str, sequence: &str, expected: &str) -> Result<(), CodeModeFrameErrorV1> {
    if schema != 1 || frame_type != expected || !valid_id(request_id) || !canonical_u64(sequence) {
        return Err(CodeModeFrameErrorV1::Invalid);
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_digest(value: &str) -> bool {
    ["blake3:", "sha256:"].iter().any(|prefix| value.len() == 71 && value.starts_with(prefix)
        && value[prefix.len()..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn canonical_u64(value: &str) -> bool {
    !value.is_empty() && !(value.len() > 1 && value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit()) && value.parse::<u64>().is_ok()
}

fn valid_argument_map(map: &JsonMap) -> bool {
    map.len() <= 4096 && map.keys().all(|key| key.len() <= 256 && !key.chars().any(char::is_control))
        && map.values().all(valid_json_value)
}

fn valid_json_value(value: &serde_json::Value) -> bool {
    valid_json_value_at(value, 0)
}

fn valid_json_value_at(value: &serde_json::Value, depth: usize) -> bool {
    if depth > 32 { return false; }
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
        serde_json::Value::String(value) => value.len() <= MAX_CALL_ARGUMENT_BYTES,
        serde_json::Value::Array(values) => values.len() <= 4096 && values.iter().all(|value| valid_json_value_at(value, depth + 1)),
        serde_json::Value::Object(fields) => fields.len() <= 4096
            && fields.keys().all(|key| key.len() <= 256 && !key.chars().any(char::is_control))
            && fields.values().all(|value| valid_json_value_at(value, depth + 1)),
    }
}

fn canonical_json_argument_bytes(arguments: &JsonMap) -> Result<usize, CodeModeFrameErrorV1> {
    let value = serde_json::Value::Object(arguments.clone().into_iter().collect());
    canonical_json(&value).map(|text| text.len()).ok_or(CodeModeFrameErrorV1::Invalid)
}

fn canonical_tool_definitions_bytes(tools: &[CodeModeToolV1]) -> Result<usize, CodeModeFrameErrorV1> {
    let value = serde_json::to_value(tools).map_err(|_| CodeModeFrameErrorV1::Invalid)?;
    canonical_json(&value).map(|serialized| serialized.len()).ok_or(CodeModeFrameErrorV1::Invalid)
}

pub(crate) fn codemode_public_wave_receipt_digest(
    wave_index: u8,
    rows: &[CodeModeCallResultV1],
) -> Result<String, CodeModeFrameErrorV1> {
    if rows.is_empty() || rows.len() > MAX_CALLS_PER_WAVE {
        return Err(CodeModeFrameErrorV1::Invalid);
    }
    use crate::messagepack::{self, Value, FRAME_LIMITS};
    let tuples = rows.iter().enumerate().map(|(index, row)| {
        let (Some(kind), Some(reference), Some(digest)) =
            (row.receipt_kind.as_deref(), row.receipt_ref.as_deref(), row.receipt_digest.as_deref())
        else { return Err(CodeModeFrameErrorV1::Invalid); };
        if !matches!(row.status.as_str(), "settled" | "rejected" | "cancelled") {
            return Err(CodeModeFrameErrorV1::Invalid);
        }
        Ok(Value::Array(vec![
            Value::Unsigned(u64::from(wave_index)),
            Value::Unsigned(index as u64),
            Value::String(row.call_id.clone()),
            Value::String(row.status.clone()),
            Value::String(kind.to_owned()),
            Value::String(reference.to_owned()),
            Value::String(digest.to_owned()),
        ]))
    }).collect::<Result<Vec<_>, _>>()?;
    let encoded = messagepack::encode(&Value::Array(tuples), FRAME_LIMITS)
        .map_err(|_| CodeModeFrameErrorV1::Invalid)?;
    Ok(blake3_hex(b"horizoncode.codemode-wave-receipts.v2\0", &encoded))
}

/// HostKernel's public nonempty execution digest is distinct from the private
/// EffectHost settlement digest. Every component wave must be known and ordered;
/// UNKNOWN intentionally has no public run digest.
pub(crate) fn codemode_public_run_receipt_digest(
    waves: &[(u8, Vec<CodeModeCallResultV1>)],
) -> Result<Option<String>, CodeModeFrameErrorV1> {
    use crate::messagepack::{self, Value, FRAME_LIMITS};
    if waves.is_empty() { return Ok(None); }
    let mut tuples = Vec::new();
    let mut previous_wave: Option<u8> = None;
    for (wave_index, rows) in waves {
        if previous_wave.is_some_and(|previous| *wave_index != previous.saturating_add(1))
            || (previous_wave.is_none() && *wave_index != 0)
            || rows.is_empty() || rows.len() > MAX_CALLS_PER_WAVE
        { return Err(CodeModeFrameErrorV1::Invalid); }
        previous_wave = Some(*wave_index);
        for (call_index, row) in rows.iter().enumerate() {
            if row.status == "unknown" { return Ok(None); }
            let (Some(kind), Some(reference), Some(digest)) =
                (row.receipt_kind.as_deref(), row.receipt_ref.as_deref(), row.receipt_digest.as_deref())
            else { return Err(CodeModeFrameErrorV1::Invalid); };
            if !matches!(row.status.as_str(), "settled" | "rejected" | "cancelled") {
                return Err(CodeModeFrameErrorV1::Invalid);
            }
            tuples.push(Value::Array(vec![
                Value::Unsigned(u64::from(*wave_index)),
                Value::Unsigned(call_index as u64),
                Value::String(row.call_id.clone()),
                Value::String(row.status.clone()),
                Value::String(kind.to_owned()),
                Value::String(reference.to_owned()),
                Value::String(digest.to_owned()),
            ]));
        }
    }
    let encoded = messagepack::encode(&Value::Array(tuples), FRAME_LIMITS)
        .map_err(|_| CodeModeFrameErrorV1::Invalid)?;
    Ok(Some(blake3_hex(b"horizoncode.codemode-receipts.v2\0", &encoded)))
}

/// serde_json::Value silently overwrites duplicate object keys. Decode through this
/// visitor first so the protocol rejects ambiguous JSON before any schema validation.
struct StrictJson(serde_json::Value);

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictJson;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("strict JSON value") }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> { Ok(StrictJson(serde_json::Value::Null)) }
            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> { self.visit_unit() }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> { Ok(StrictJson(value.into())) }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> { Ok(StrictJson(value.into())) }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> { Ok(StrictJson(value.into())) }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value).map(|n| StrictJson(serde_json::Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> { Ok(StrictJson(value.into())) }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> { Ok(StrictJson(value.into())) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<StrictJson>()? { values.push(value.0); }
                Ok(StrictJson(serde_json::Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, StrictJson>()? {
                    if values.contains_key(&key) { return Err(serde::de::Error::custom("duplicate JSON object key")); }
                    values.insert(key, value.0);
                }
                Ok(StrictJson(serde_json::Value::Object(values)))
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}

fn schema_digest(schema: &JsonMap) -> Option<String> {
    let canonical = canonical_schema_json(&serde_json::Value::Object(schema.clone().into_iter().collect()))?;
    Some(blake3_hex(b"horizon.tool-schema.v1\0", canonical.as_bytes()))
}

fn tool_set_digest(tools: &[CodeModeToolV1]) -> Option<String> {
    use crate::messagepack::{self, Value as Mp};
    let rows = tools.iter().map(|tool| Some(Mp::Map(BTreeMap::from([
        ("toolName".into(), Mp::String(tool.tool_name.clone())),
        ("capabilityId".into(), Mp::String(tool.capability_id.clone())),
        ("description".into(), Mp::String(tool.description.clone())),
        ("inputSchema".into(), json_to_mp(&serde_json::Value::Object(tool.input_schema.clone().into_iter().collect()))?),
        ("inputSchemaDigest".into(), Mp::String(tool.input_schema_digest.clone())),
    ])))).collect::<Option<Vec<_>>>()?;
    let limits = messagepack::Limits { max_encoded_bytes: 256 * 1024, max_depth: 16,
        max_nodes: 4096, max_collection_items: 4096, max_scalar_bytes: 64 * 1024 };
    let bytes = messagepack::encode(&Mp::Array(rows), limits).ok()?;
    Some(blake3_hex(b"horizoncode.codemode-toolset.v1\0", &bytes))
}

/// Canonical digest of the exact host-selected tool projection, exposed to the
/// private EffectHost admission adapter. Helper-provided start frames are not authority.
pub(crate) fn authorized_tool_set_digest(tools: &[CodeModeToolV1]) -> Option<String> {
    tool_set_digest(tools)
}

fn json_to_mp(value: &serde_json::Value) -> Option<crate::messagepack::Value> {
    use crate::messagepack::Value as Mp;
    Some(match value {
        serde_json::Value::Null => Mp::Nil,
        serde_json::Value::Bool(value) => Mp::Bool(*value),
        serde_json::Value::String(value) => Mp::String(value.clone()),
        serde_json::Value::Number(value) => {
            let number = value.as_f64()?;
            if number.is_finite() && number.fract() == 0.0
                && number >= -9_007_199_254_740_991.0 && number <= 9_007_199_254_740_991.0 {
                if number >= 0.0 { Mp::Unsigned(number as u64) } else { Mp::Signed(number as i64) }
            } else { Mp::Float(number.to_bits()) }
        }
        serde_json::Value::Array(values) => Mp::Array(values.iter().map(json_to_mp).collect::<Option<Vec<_>>>()?),
        serde_json::Value::Object(values) => Mp::Map(values.iter().map(|(key, value)| Some((key.clone(), json_to_mp(value)?)))
            .collect::<Option<BTreeMap<_, _>>>()?),
    })
}

fn canonical_json(value: &serde_json::Value) -> Option<String> {
    Some(match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => {
            let number = value.as_f64()?;
            if number == 0.0 { "0".into() }
            else if number.fract() == 0.0 && number >= -9_007_199_254_740_991.0 && number <= 9_007_199_254_740_991.0 {
                (number as i64).to_string()
            } else { number.to_string() }
        }
        serde_json::Value::String(value) => serde_json::to_string(value).ok()?,
        serde_json::Value::Array(values) => format!("[{}]", values.iter().map(canonical_json).collect::<Option<Vec<_>>>()?.join(",")),
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|a,b| a.as_bytes().cmp(b.as_bytes()));
            let entries = keys.into_iter().map(|key| Some(format!("{}:{}", serde_json::to_string(key).ok()?, canonical_json(&values[key])?)))
                .collect::<Option<Vec<_>>>()?;
            format!("{{{}}}", entries.join(","))
        }
    })
}

// The existing TypeScript schema digest uses Object.keys(...).sort(), whose
// ordering is UTF-16 code-unit order. Keep that exact ordering separate from
// canonical argument JSON, whose contract explicitly sorts UTF-8 bytes.
fn canonical_schema_json(value: &serde_json::Value) -> Option<String> {
    Some(match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => {
            let number = value.as_f64()?;
            if number == 0.0 { "0".into() }
            else if number.fract() == 0.0 && number >= -9_007_199_254_740_991.0 && number <= 9_007_199_254_740_991.0 {
                (number as i64).to_string()
            } else { number.to_string() }
        }
        serde_json::Value::String(value) => serde_json::to_string(value).ok()?,
        serde_json::Value::Array(values) => format!("[{}]", values.iter().map(canonical_schema_json).collect::<Option<Vec<_>>>()?.join(",")),
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let entries = keys.into_iter().map(|key| Some(format!("{}:{}", serde_json::to_string(key).ok()?, canonical_schema_json(&values[key])?)))
                .collect::<Option<Vec<_>>>()?;
            format!("{{{}}}", entries.join(","))
        }
    })
}

fn blake3_hex(domain: &[u8], payload: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(domain);
    hasher.update(payload);
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn codemode_tool_result_digest_v1(output: &str) -> Result<String, CodeModeFrameErrorV1> {
    use crate::messagepack::{self, Value, FRAME_LIMITS};
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(CodeModeFrameErrorV1::Invalid);
    }
    let projection = Value::Map(BTreeMap::from([("output".to_owned(), Value::String(output.to_owned()))]));
    let encoded = messagepack::encode(&projection, FRAME_LIMITS).map_err(|_| CodeModeFrameErrorV1::Invalid)?;
    Ok(blake3_hex(b"horizoncode.codemode-tool-result.v1\0", &encoded))
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    fn start_frame() -> CodeModeStartV1 {
        let schema = BTreeMap::from([("type".to_owned(), serde_json::json!("object"))]);
        let tool = CodeModeToolV1 {
            tool_name: "files.write".into(), capability_id: "files.write".into(),
            description: "write file".into(), input_schema: schema.clone(),
            input_schema_digest: schema_digest(&schema).unwrap(),
        };
        let tools = vec![tool];
        CodeModeStartV1 {
            schema_version: 1, frame_type: "start".into(), request_id: "request-1".into(),
            sequence: "0".into(), code: "return 1".into(),
            tool_set_digest: tool_set_digest(&tools).unwrap(),
            tool_definitions_bytes: canonical_tool_definitions_bytes(&tools).unwrap(),
            tools,
        }
    }

    fn wave_result_at(call_ids: &[&str], status: &str, sequence: &str, wave_index: u8) -> CodeModeFrameV1 {
        let results = call_ids.iter().map(|id| CodeModeCallResultV1 {
            call_id: (*id).into(), status: status.into(), output: None,
            result_digest: None, output_bytes: None,
            receipt_ref: Some(format!("receipt-{id}")),
            receipt_kind: Some("effect_receipt".into()),
            receipt_digest: Some(format!("blake3:{}", "a".repeat(64))), error_code: None,
        }).collect::<Vec<_>>();
        let receipt_digest = codemode_public_wave_receipt_digest(wave_index, &results).unwrap();
        CodeModeFrameV1::WaveResult(CodeModeWaveResultV1 {
            schema_version: 1, frame_type: "wave_result".into(), request_id: "request-1".into(),
            sequence: sequence.into(), wave_index, batch_id: "batch-1".into(), status: status.into(),
            results,
            receipt_digest: Some(receipt_digest),
        })
    }

    fn wave_result(call_ids: &[&str], status: &str) -> CodeModeFrameV1 {
        wave_result_at(call_ids, status, "2", 0)
    }

    fn wave_request(call_id: &str, sequence: &str, wave_index: u8, argument_bytes: usize) -> CodeModeFrameV1 {
        CodeModeFrameV1::WaveRequest(CodeModeWaveRequestV1 {
            schema_version: 1, frame_type: "wave_request".into(), request_id: "request-1".into(),
            sequence: sequence.into(), wave_index,
            calls: vec![CodeModeCallV1 {
                call_id: call_id.into(), tool_name: "files.write".into(), capability_id: "files.write".into(),
                argument_bytes, arguments: BTreeMap::new(),
            }],
        })
    }

    #[test]
    fn start_recomputes_canonical_tool_definition_bytes() {
        let mut start = start_frame();
        let frame = CodeModeFrameV1::Start(start.clone());
        assert!(frame.to_json_line().is_ok());
        start.tool_definitions_bytes += 1;
        assert_eq!(CodeModeFrameV1::Start(start).validate(), Err(CodeModeFrameErrorV1::Invalid));
    }

    #[test]
    fn wave_results_must_correlate_in_exact_call_order() {
        let start = CodeModeFrameV1::Start(start_frame());
        let mut conversation = CodeModeConversationV1::start(&start).unwrap();
        let arguments = BTreeMap::new();
        let wave = CodeModeFrameV1::WaveRequest(CodeModeWaveRequestV1 {
            schema_version: 1, frame_type: "wave_request".into(), request_id: "request-1".into(),
            sequence: "1".into(), wave_index: 0,
            calls: ["call-a", "call-b"].into_iter().map(|call_id| CodeModeCallV1 {
                call_id: call_id.into(), tool_name: "files.write".into(), capability_id: "files.write".into(),
                argument_bytes: 2, arguments: arguments.clone(),
            }).collect(),
        });
        assert_eq!(conversation.accept_helper_frame(&wave).unwrap(), Some(2));
        assert_eq!(conversation.accept_host_wave_result(&wave_result(&["call-b", "call-a"], "settled")), Err(CodeModeFrameErrorV1::Invalid));
        assert!(conversation.accept_host_wave_result(&wave_result(&["call-a", "call-b"], "settled")).is_ok());
    }

    #[test]
    fn settled_tool_result_requires_matching_digest_and_utf8_byte_count() {
        let output = "é🙂";
        let result = CodeModeCallResultV1 {
            call_id: "call-read".into(),
            status: "settled".into(),
            output: Some(output.into()),
            result_digest: Some(codemode_tool_result_digest_v1(output).unwrap()),
            output_bytes: Some(output.as_bytes().len()),
            receipt_ref: Some("tool_result:call-read".into()),
            receipt_kind: Some("tool_result".into()),
            receipt_digest: Some(format!("blake3:{}", "a".repeat(64))),
            error_code: None,
        };
        let mut frame = CodeModeWaveResultV1 {
            schema_version: 1, frame_type: "wave_result".into(), request_id: "request-1".into(),
            sequence: "2".into(), wave_index: 0, batch_id: "batch-1".into(), status: "settled".into(),
            results: vec![result], receipt_digest: None,
        };
        frame.receipt_digest = Some(codemode_public_wave_receipt_digest(0, &frame.results).unwrap());
        let valid = CodeModeFrameV1::WaveResult(frame.clone());
        assert!(valid.validate().is_ok());
        let encoded = valid.to_json_line().unwrap();
        let decoded = CodeModeFrameV1::from_json_line(&encoded).unwrap();
        assert_eq!(decoded, valid);

        let mut wrong_bytes = frame.clone();
        wrong_bytes.results[0].output_bytes = Some(output.chars().count());
        assert_eq!(CodeModeFrameV1::WaveResult(wrong_bytes).validate(), Err(CodeModeFrameErrorV1::Invalid));

        let mut wrong_digest = frame.clone();
        wrong_digest.results[0].result_digest = Some(format!("blake3:{}", "b".repeat(64)));
        assert_eq!(CodeModeFrameV1::WaveResult(wrong_digest).validate(), Err(CodeModeFrameErrorV1::Invalid));

        let mut missing_digest = frame;
        missing_digest.results[0].result_digest = None;
        assert_eq!(CodeModeFrameV1::WaveResult(missing_digest).validate(), Err(CodeModeFrameErrorV1::Invalid));
    }

    #[test]
    fn known_rejected_result_is_terminal_and_allows_one_failed_completion() {
        let start = CodeModeFrameV1::Start(start_frame());
        let mut conversation = CodeModeConversationV1::start(&start).unwrap();
        let wave = wave_request("call-a", "1", 0, 2);
        assert_eq!(conversation.accept_helper_frame(&wave).unwrap(), Some(2));
        assert!(conversation.accept_host_wave_result(&wave_result(&["call-a"], "rejected")).is_ok());
        assert!(conversation.terminal);
        let next = wave_request("call-b", "3", 1, 2);
        assert_eq!(conversation.accept_helper_frame(&next), Err(CodeModeFrameErrorV1::Invalid));
        let completed = CodeModeFrameV1::Completed(CodeModeCompletedV1 {
            schema_version: 1, frame_type: "completed".into(), request_id: "request-1".into(),
            sequence: "3".into(), status: "failed".into(), output: Some("done".into()),
            truncated: Some(false), error_code: None,
        });
        assert!(conversation.accept_helper_frame(&completed).is_ok());
        assert_eq!(conversation.accept_helper_frame(&completed), Err(CodeModeFrameErrorV1::Invalid));
        assert!(conversation.terminal);
    }

    #[test]
    fn cancelled_wave_allows_only_one_helper_completion_and_unknown_allows_none() {
        let start = CodeModeFrameV1::Start(start_frame());
        let mut cancelled = CodeModeConversationV1::start(&start).unwrap();
        let wave = wave_request("call-a", "1", 0, 2);
        cancelled.accept_helper_frame(&wave).unwrap();
        cancelled.accept_host_wave_result(&wave_result(&["call-a"], "cancelled")).unwrap();
        let completed = CodeModeFrameV1::Completed(CodeModeCompletedV1 {
            schema_version: 1, frame_type: "completed".into(), request_id: "request-1".into(),
            sequence: "3".into(), status: "cancelled".into(), output: None,
            truncated: Some(false), error_code: None,
        });
        assert!(cancelled.accept_helper_frame(&completed).is_ok());
        assert_eq!(cancelled.accept_helper_frame(&completed), Err(CodeModeFrameErrorV1::Invalid));

        let mut unknown = CodeModeConversationV1::start(&start).unwrap();
        unknown.accept_helper_frame(&wave).unwrap();
        let unknown_result = CodeModeFrameV1::WaveResult(CodeModeWaveResultV1 {
            schema_version: 1, frame_type: "wave_result".into(), request_id: "request-1".into(),
            sequence: "2".into(), wave_index: 0, batch_id: "batch-1".into(), status: "unknown".into(),
            results: vec![CodeModeCallResultV1 { call_id: "call-a".into(), status: "unknown".into(),
                output: None, result_digest: None, output_bytes: None, receipt_ref: None, receipt_kind: None,
                receipt_digest: None, error_code: None }],
            receipt_digest: None,
        });
        unknown.accept_host_wave_result(&unknown_result).unwrap();
        assert_eq!(unknown.accept_helper_frame(&completed), Err(CodeModeFrameErrorV1::Invalid));
    }

    #[test]
    fn one_wave_argument_bytes_cannot_exceed_toolbatch_limit() {
        let calls = (0..3).map(|index| {
            let arguments = BTreeMap::from([("payload".to_owned(), serde_json::Value::String("x".repeat(200_000)))]);
            let argument_bytes = canonical_json_argument_bytes(&arguments).unwrap();
            CodeModeCallV1 {
                call_id: format!("call-{index}"), tool_name: "files.write".into(),
                capability_id: "files.write".into(), argument_bytes, arguments,
            }
        }).collect();
        let frame = CodeModeFrameV1::WaveRequest(CodeModeWaveRequestV1 {
            schema_version: 1, frame_type: "wave_request".into(), request_id: "request-1".into(),
            sequence: "1".into(), wave_index: 0, calls,
        });
        assert_eq!(frame.validate(), Err(CodeModeFrameErrorV1::Invalid));

        let start = CodeModeFrameV1::Start(start_frame());
        let mut conversation = CodeModeConversationV1::start(&start).unwrap();
        let wave = wave_request("call-a", "1", 0, 2);
        conversation.accept_helper_frame(&wave).unwrap();
        let CodeModeFrameV1::WaveResult(mut forged) = wave_result(&["call-a"], "rejected") else { unreachable!() };
        forged.receipt_digest = Some(format!("blake3:{}", "f".repeat(64)));
        let forged = CodeModeFrameV1::WaveResult(forged);
        // Schema/frame validation checks shape; the stateful host receiver binds
        // the aggregate digest to this exact accepted wave.
        assert!(forged.validate().is_ok());
        assert_eq!(conversation.accept_host_wave_result(&forged), Err(CodeModeFrameErrorV1::Invalid));
    }
}
