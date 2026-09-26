//! A credential wrapper whose `Debug` output is redacted.

/// A UTF-8 secret that never reveals itself in `Debug` or `Display` output.
///
/// The value is intentionally not `Serialize`, `Clone`-by-accident,
/// `PartialEq`, or `Display`, so accidental logging and accidental comparison
/// are both compile errors. Use [`SecretString::expose`] at the single call
/// site that constructs the `Authorization` header.
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    /// Wraps a credential value.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the raw value. Call exactly where the secret is required.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Returns whether the secret is non-empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_reveals_the_secret() {
        let secret = SecretString::new("super-secret-value");
        assert_eq!(format!("{secret:?}"), "SecretString(***)");
        assert!(!format!("{secret:?}").contains("super-secret-value"));
        assert_eq!(secret.expose(), "super-secret-value");
    }
}
