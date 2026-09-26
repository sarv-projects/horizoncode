//! Opaque, ordered identifiers.
//!
//! Session ids are minted as UUIDv7 so they sort by creation time
//! (`ARCH/07-SESSION.md`). Turn, step and tool-call ids are session-local
//! opaque strings; callers should treat them as values, never parse them.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Marks a type as an opaque agentX identifier.
pub trait Id: Clone + fmt::Debug + fmt::Display + PartialEq + Eq + std::hash::Hash {
    /// Returns the identifier as a borrowed string slice.
    fn as_str(&self) -> &str;
}

macro_rules! opaque_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps an existing identifier value.
            #[must_use]
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Returns the identifier as a string slice.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Generates a new process-unique identifier with the type's prefix.
            #[must_use]
            pub fn generate() -> Self {
                let uuid = Uuid::now_v7();
                Self(format!("{}{}", $prefix, uuid.simple()))
            }
        }

        impl Id for $name {
            fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!(stringify!($name), "({:?})"), self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

opaque_id!(
    /// Identifies a durable, portable session (`~/.agentx/sessions/<id>.jsonl`).
    SessionId,
    "ses_"
);
opaque_id!(
    /// Identifies one admitted batch of user-facing work within a session.
    TurnId,
    "turn_"
);
opaque_id!(
    /// Identifies one provider request within a turn.
    StepId,
    "step_"
);
opaque_id!(
    /// Identifies one tool invocation emitted by the model.
    ToolCallId,
    "call_"
);

impl SessionId {
    /// Mints a time-ordered UUIDv7 session identifier.
    #[must_use]
    pub fn new_v7() -> Self {
        Self(format!("ses_{}", Uuid::now_v7().simple()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_unique_and_prefixed() {
        let a = SessionId::new_v7();
        let b = SessionId::new_v7();
        assert_ne!(a, b);
        assert!(a.as_str().starts_with("ses_"));
    }

    #[test]
    fn generated_ids_carry_type_prefixes() {
        assert!(TurnId::generate().as_str().starts_with("turn_"));
        assert!(StepId::generate().as_str().starts_with("step_"));
        assert!(ToolCallId::generate().as_str().starts_with("call_"));
    }

    #[test]
    fn ids_round_trip_through_json_as_strings() {
        let id = SessionId::new_v7();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{id}\""));
        let back: SessionId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }
}
