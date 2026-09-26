//! The `question` tool: gather a human decision (interactive surfaces only).

use std::sync::Arc;

use agentx_types::{ContentPart, ToolDefinition};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::builtin::object_schema;
use crate::error::ToolError;
use crate::registry::{Tool, ToolContext, ToolOutput};

/// One question to put to the user.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// A short header.
    pub header: String,
    /// The question text.
    pub question: String,
    /// Optional selectable answers.
    pub options: Vec<String>,
}

/// Resolves questions against an interactive surface.
#[async_trait]
pub trait QuestionHandler: Send + Sync + std::fmt::Debug {
    /// Asks the questions and returns one answer label per question.
    ///
    /// # Errors
    /// Returns a typed [`ToolError`] when the surface cannot answer.
    async fn ask(&self, questions: &[Question]) -> Result<Vec<String>, ToolError>;
}

/// Asks the user questions; unavailable in non-interactive runs.
#[derive(Debug)]
pub struct QuestionTool {
    handler: Option<Arc<dyn QuestionHandler>>,
}

impl QuestionTool {
    /// Builds an interactive question tool.
    #[must_use]
    pub fn new(handler: Arc<dyn QuestionHandler>) -> Self {
        Self {
            handler: Some(handler),
        }
    }

    /// Builds a tool that is unavailable (the headless posture).
    #[must_use]
    pub fn unavailable() -> Self {
        Self { handler: None }
    }
}

impl Default for QuestionTool {
    fn default() -> Self {
        Self::unavailable()
    }
}

#[async_trait]
impl Tool for QuestionTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "question",
            "Ask the user one or more questions when a decision is required. \
             Unavailable in non-interactive runs.",
            object_schema(
                json!({
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "header": { "type": "string" },
                                "question": { "type": "string" },
                                "options": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                }
                            },
                            "required": ["question"],
                            "additionalProperties": false
                        }
                    }
                }),
                &["questions"],
            ),
            None,
        )
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let Some(handler) = &self.handler else {
            return Err(ToolError::Unavailable(
                "question is unavailable in non-interactive runs".to_owned(),
            ));
        };
        let raw = input
            .get("questions")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::InvalidInput("`questions` must be an array".to_owned()))?;
        let mut questions = Vec::with_capacity(raw.len());
        for (index, value) in raw.iter().enumerate() {
            let question = value
                .get("question")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("question {index} needs non-empty `question`"))
                })?;
            let header = value
                .get("header")
                .and_then(Value::as_str)
                .unwrap_or("question")
                .to_owned();
            let options = value
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            questions.push(Question {
                header,
                question,
                options,
            });
        }
        let answers = handler.ask(&questions).await?;
        Ok(ToolOutput {
            model_content: vec![ContentPart::text(
                answers
                    .iter()
                    .enumerate()
                    .map(|(index, answer)| format!("Q{}: {answer}", index + 1))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )],
            structured: Some(json!({ "answers": answers })),
            ui_detail: None,
        })
    }
}
