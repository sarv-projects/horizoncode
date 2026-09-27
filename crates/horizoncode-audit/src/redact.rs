//! The redaction pass that runs **before** an entry is hashed
//! (`REQ-AUDIT-003`, `ARCH/14-AUDIT.md` §Secret redaction guarantees).
//!
//! The pass covers four sources, as the architecture requires:
//!
//! 1. explicitly registered secret values (environment-derived values the
//!    operator or provider layer hands in);
//! 2. `Bearer <token>` shapes, even when the token was never registered;
//! 3. URL userinfo (`scheme://user:password@host`);
//! 4. any text that matches a credential-shaped field name or value.
//!
//! Because the pass is applied to the record *before* the hash is computed, a
//! secret can never enter the chain: the chain only ever covers the placeholder.

/// The placeholder substituted for redacted material.
pub const REDACTED: &str = "***";

/// Field-name fragments whose text value is always replaced.
const SENSITIVE_FRAGMENTS: &[&str] = &[
    "api_key",
    "api-key",
    "apikey",
    "authorization",
    "access_token",
    "credential",
    "id_token",
    "passphrase",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "session_token",
    "token",
];

/// Environment variable names whose values are treated as secrets when the
/// caller registers them.
pub const SECRET_ENV_KEYS: &[&str] = &[
    "HORIZONCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
];

/// Replaces known secrets and credential-shaped substrings.
#[derive(Clone, Debug, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    /// Builds a redactor for the given secret values; empties are ignored.
    #[must_use]
    pub fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        let mut redactor = Self::default();
        for secret in secrets {
            redactor.add_secret(secret);
        }
        redactor
    }

    /// Builds a redactor seeded from a process environment, honouring the
    /// declared secret variable names.
    ///
    /// The values never leave this struct: only the placeholder is ever written.
    #[must_use]
    pub fn from_env_vars(vars: &[(String, String)]) -> Self {
        let secrets = vars
            .iter()
            .filter(|(name, value)| !value.is_empty() && is_secret_env_name(name))
            .map(|(_, value)| value.clone());
        Self::new(secrets)
    }

    /// Adds a secret value.
    pub fn add_secret(&mut self, secret: impl Into<String>) {
        let secret = secret.into();
        if secret.len() >= MIN_SECRET_LEN && !self.secrets.contains(&secret) {
            self.secrets.push(secret);
        }
    }

    /// Returns the number of registered secret values.
    #[must_use]
    pub fn secret_count(&self) -> usize {
        self.secrets.len()
    }

    /// Redacts `text`, returning whether anything was replaced.
    pub fn redact_into(&self, text: &mut String) -> bool {
        let original = text.len();
        let redacted = self.redact(text);
        if redacted.len() == original && redacted == *text {
            return false;
        }
        *text = redacted;
        true
    }

    /// Returns a redacted copy of `text`.
    #[must_use]
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for secret in &self.secrets {
            if out.contains(secret.as_str()) {
                out = out.replace(secret.as_str(), REDACTED);
            }
        }
        out = redact_bearer(&out);
        out = redact_url_userinfo(&out);
        out = redact_assignment(&out);
        out
    }
}

/// Shortest value that may be registered as a secret; registering a one or two
/// character value would redact unrelated text everywhere.
const MIN_SECRET_LEN: usize = 6;

/// Returns whether an environment variable name is a declared secret source.
#[must_use]
pub fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if SECRET_ENV_KEYS.contains(&upper.as_str()) {
        return true;
    }
    let lower = upper.to_ascii_lowercase();
    SENSITIVE_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
}

fn redact_bearer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("Bearer ").or_else(|| rest.find("bearer ")) {
        out.push_str(&rest[..index]);
        let token_start = index + "Bearer ".len();
        let token_end = rest[token_start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '}')
            .map_or(rest.len(), |offset| token_start + offset);
        out.push_str("Bearer ");
        out.push_str(REDACTED);
        rest = &rest[token_end..];
    }
    out.push_str(rest);
    out
}

fn redact_url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let authority_start = scheme_end + 3;
        let authority_end = rest[authority_start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .map_or(rest.len(), |offset| authority_start + offset);
        let authority = &rest[authority_start..authority_end];
        let Some(at) = authority.rfind('@') else {
            out.push_str(&rest[..authority_end]);
            rest = &rest[authority_end..];
            continue;
        };
        out.push_str(&rest[..authority_start]);
        out.push_str(REDACTED);
        out.push('@');
        out.push_str(&authority[at + 1..]);
        rest = &rest[authority_end..];
    }
    out.push_str(rest);
    out
}

/// Replaces `name=value` / `name: value` for sensitive field names.
fn redact_assignment(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((value_start, value_end)) = find_sensitive_assignment(rest) {
        out.push_str(&rest[..value_start]);
        out.push_str(REDACTED);
        rest = &rest[value_end..];
    }
    out.push_str(rest);
    out
}

/// Finds the first `sensitive-name = value` in `text` as a byte range.
fn find_sensitive_assignment(text: &str) -> Option<(usize, usize)> {
    let mut line_start = 0usize;
    let mut best: Option<(usize, usize)> = None;
    for line in text.split_inclusive('\n') {
        if let Some(found) = sensitive_value_range(line) {
            let candidate = (line_start + found.0, line_start + found.1);
            best = Some(match best {
                // Prefer the widest value span on the line so that overlapping
                // fragments (`token` inside `refresh_token`) redact the whole
                // value rather than a prefix of it.
                Some(current) if current.1 - current.0 >= candidate.1 - candidate.0 => current,
                _ => candidate,
            });
        }
        line_start += line.len();
    }
    best
}

/// Auth schemes whose bearer-style credential the bearer pass already
/// redacts. The assignment pass leaves them alone so it cannot truncate
/// `Authorization: Bearer <token>` down to the scheme word.
const AUTH_SCHEMES: &[&str] = &[
    "Bearer", "bearer", "Basic", "basic", "Digest", "Token", "token",
];

/// Returns whether an unquoted value is an auth scheme word followed by a
/// credential, which the bearer pass handles.
fn is_auth_scheme_value(value: &str) -> bool {
    let mut parts = value.split_whitespace();
    let Some(first) = parts.next() else {
        return false;
    };
    AUTH_SCHEMES.contains(&first) && parts.next().is_some()
}

/// Returns the value byte range of a sensitive assignment on one line.
fn sensitive_value_range(line: &str) -> Option<(usize, usize)> {
    let lower = line.to_ascii_lowercase();
    let mut best: Option<(usize, usize)> = None;
    for fragment in SENSITIVE_FRAGMENTS {
        for start in lower.match_indices(fragment).map(|(index, _)| index) {
            // The fragment must end a field name, not sit inside a word.
            let boundary_ok = lower[..start]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_alphanumeric() && c != '_');
            if !boundary_ok {
                continue;
            }
            let name_end = start + fragment.len();
            let Some(value_start) = separator_value_start(&line[name_end..]) else {
                continue;
            };
            let value_start = name_end + value_start;
            let Some(len) = value_len(&line[value_start..]) else {
                continue;
            };
            let raw = &line[value_start..value_start + len];
            let quoted = raw.starts_with('"') || raw.starts_with('\'');
            if !quoted && is_auth_scheme_value(&line[value_start..]) {
                continue;
            }
            let candidate = (value_start, value_start + len);
            best = Some(match best {
                Some(current) if current.1 - current.0 >= candidate.1 - candidate.0 => current,
                _ => candidate,
            });
        }
    }
    best
}

/// Returns the offset of the value after `= value`, `: value`, or a quoted
/// form, skipping leading whitespace and an optional opening quote.
fn separator_value_start(rest: &str) -> Option<usize> {
    // A JSON field name is quoted, so the fragment is followed by the closing
    // quote before the separator.
    let after_name_quote = rest
        .strip_prefix('"')
        .or_else(|| rest.strip_prefix('\''))
        .unwrap_or(rest);
    let mut offset = rest.len() - after_name_quote.len();
    let before_sep = after_name_quote.trim_start_matches([' ', '\t']);
    offset += after_name_quote.len() - before_sep.len();
    let after_sep = before_sep
        .strip_prefix('=')
        .or_else(|| before_sep.strip_prefix(':'))?;
    offset += 1;
    let after_spaces = after_sep.trim_start_matches([' ', '\t']);
    // The value span deliberately *includes* its opening quote so that
    // `value_len` can see the quoted form and run to the matching close.
    offset += after_sep.len() - after_spaces.len();
    Some(offset)
}

/// Returns the byte length of the value starting at `text`.
fn value_len(text: &str) -> Option<usize> {
    let trimmed = text.trim_start();
    let skipped = text.len() - trimmed.len();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix('"') {
        return stripped.find('"').map(|end| skipped + 1 + end + 1);
    }
    if let Some(stripped) = trimmed.strip_prefix('\'') {
        return stripped.find('\'').map(|end| skipped + 1 + end + 1);
    }
    let end = trimmed
        .find(|c: char| c.is_whitespace() || c == ',' || c == '}' || c == ']')
        .unwrap_or(trimmed.len());
    (end > 0).then_some(skipped + end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_registered_secret() {
        let redactor = Redactor::new(["hunter2-secret".to_owned()]);
        let text = redactor.redact("key hunter2-secret attached");
        assert_eq!(text, "key *** attached");
        assert!(!text.contains("hunter2-secret"));
    }

    #[test]
    fn refuses_to_register_a_trivially_short_value() {
        let redactor = Redactor::new(["ab".to_owned()]);
        assert_eq!(redactor.secret_count(), 0);
    }

    #[test]
    fn redacts_bearer_tokens_even_when_unregistered() {
        let redactor = Redactor::default();
        assert_eq!(
            redactor.redact("Authorization: Bearer tok_9999"),
            "Authorization: Bearer ***"
        );
    }

    #[test]
    fn redacts_url_userinfo() {
        let redactor = Redactor::default();
        assert_eq!(
            redactor.redact("base https://alice:hunter2-pass@example.invalid/v1"),
            "base https://***@example.invalid/v1"
        );
    }

    #[test]
    fn redacts_sensitive_assignments() {
        let redactor = Redactor::default();
        assert_eq!(
            redactor.redact("api_key=abcdef123456 rest"),
            "api_key=*** rest"
        );
        // The whole quoted value is replaced, quotes included: the pass is a
        // text substitution, not a structured-document editor.
        assert_eq!(
            redactor.redact("\"password\": \"open-sesame\" }"),
            "\"password\": *** }"
        );
        assert!(
            !redactor
                .redact("\"password\": \"open-sesame\" }")
                .contains("open-sesame")
        );
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let redactor = Redactor::default();
        let text = "wrote 3 files under src/, 1.5 s, exit 0";
        assert_eq!(redactor.redact(text), text);
    }

    #[test]
    fn env_seeding_only_registers_declared_secret_names() {
        let vars = vec![
            ("HORIZONCODE_API_KEY".to_owned(), "env-secret-value".to_owned()),
            ("PATH".to_owned(), "/usr/bin".to_owned()),
        ];
        let redactor = Redactor::from_env_vars(&vars);
        assert_eq!(redactor.secret_count(), 1);
        assert_eq!(redactor.redact("using env-secret-value"), "using ***");
        assert_eq!(redactor.redact("path /usr/bin"), "path /usr/bin");
    }

    #[test]
    fn redact_into_reports_whether_anything_changed() {
        let redactor = Redactor::new(["registered-secret".to_owned()]);
        let mut value = String::from("registered-secret");
        assert!(redactor.redact_into(&mut value));
        assert_eq!(value, REDACTED);
        let mut untouched = String::from("plain value");
        assert!(!redactor.redact_into(&mut untouched));
        assert_eq!(untouched, "plain value");
    }
}
