//! The `todo` tool: a per-session task list.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use horizoncode_types::{ContentPart, ToolDefinition};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::builtin::{assert_action, object_schema};
use crate::error::ToolError;
use crate::registry::{Tool, ToolContext, ToolOutput};

/// The lifecycle state of a todo item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    /// Not started.
    Pending,
    /// Actively being worked.
    InProgress,
    /// Finished.
    Completed,
    /// Abandoned.
    Cancelled,
}

impl TodoStatus {
    /// Parses a status name.
    ///
    /// # Errors
    /// Returns [`ToolError::InvalidInput`] for an unknown status.
    pub fn parse(value: &str) -> Result<Self, ToolError> {
        match value {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "cancelled" | "canceled" => Ok(Self::Cancelled),
            other => Err(ToolError::InvalidInput(format!(
                "unknown todo status `{other}`"
            ))),
        }
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One todo item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    /// A stable item id.
    pub id: String,
    /// The task text.
    pub content: String,
    /// The lifecycle state.
    pub status: TodoStatus,
}

/// Per-session todo state shared across calls.
#[derive(Debug, Default)]
pub struct TodoStore {
    inner: Mutex<HashMap<String, Vec<TodoItem>>>,
}

impl TodoStore {
    /// Builds an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the todo list for a session and returns it.
    pub fn replace(&self, session: &str, items: Vec<TodoItem>) -> Vec<TodoItem> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.to_owned(), items.clone());
        items
    }

    /// Returns the todo list for a session.
    #[must_use]
    pub fn get(&self, session: &str) -> Vec<TodoItem> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session)
            .cloned()
            .unwrap_or_default()
    }
}

/// Maintains the session todo list.
#[derive(Debug)]
pub struct TodoTool {
    store: Arc<TodoStore>,
}

impl TodoTool {
    /// Builds a todo tool backed by a shared store.
    #[must_use]
    pub fn new(store: Arc<TodoStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for TodoTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "todo",
            "Replace the session todo list. Use it to track multi-step work and \
             keep statuses truthful.",
            object_schema(
                json!({
                    "todos": {
                        "type": "array",
                        "description": "The complete todo list.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "content": { "type": "string" },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "cancelled"]
                                }
                            },
                            "required": ["content"],
                            "additionalProperties": false
                        }
                    }
                }),
                &["todos"],
            ),
            None,
        )
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let raw = input
            .get("todos")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::InvalidInput("`todos` must be an array".to_owned()))?;
        let mut items = Vec::with_capacity(raw.len());
        for (index, value) in raw.iter().enumerate() {
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("todo {index} needs a non-empty `content`"))
                })?;
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| format!("todo_{}", index + 1));
            let status = match value.get("status").and_then(Value::as_str) {
                Some(status) => TodoStatus::parse(status)?,
                None => TodoStatus::Pending,
            };
            items.push(TodoItem {
                id,
                content,
                status,
            });
        }
        assert_action(ctx, "todo", vec!["*".to_owned()], Vec::new()).await?;
        let items = self.store.replace(ctx.session_id.as_str(), items);
        let rendered = items
            .iter()
            .map(|item| format!("[{}] {}: {}", item.status.as_str(), item.id, item.content))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolOutput {
            model_content: vec![ContentPart::text(if rendered.is_empty() {
                "todo list cleared".to_owned()
            } else {
                rendered
            })],
            structured: Some(json!({ "todos": items })),
            ui_detail: None,
        })
    }
}
