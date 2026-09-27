//! Model-visible content parts.

use serde::{Deserialize, Serialize};

/// A single part of a model message.
///
/// The slice ships text only; the enum is `#[non_exhaustive]` so image,
/// audio and file parts can be added additively (`ARCH/10-TOOLS.md`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ContentPart {
    /// Plain UTF-8 text.
    Text {
        /// The text payload.
        text: String,
    },
}

impl ContentPart {
    /// Builds a text content part.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// Returns the borrowed text payload when this part is text.
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
        }
    }
}

impl From<&str> for ContentPart {
    fn from(value: &str) -> Self {
        Self::text(value)
    }
}

impl From<String> for ContentPart {
    fn from(value: String) -> Self {
        Self::Text { text: value }
    }
}
