//! Shared wildcard grammar for actions, paths and command prefixes
//! (`ARCH/12-GUARD.md`).
//!
//! `*` matches within one separator-delimited segment, `**` spans segments,
//! and `?` matches a single non-separator character. The grammar is small and
//! deliberately shared so a pattern means the same thing to Guard and to the
//! sandbox deny set. Character classes are not supported; a pattern containing
//! `[`/`]`/`{`/`}` is rejected as malformed rather than silently ignored.

use crate::error::GuardError;

/// The separator discipline applied to a pattern.
///
/// `*` never crosses a separator from this set; `**` crosses everything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchMode {
    /// Dotted capability actions (`fs.read`); separators are `.`.
    Dotted,
    /// Filesystem paths (`src/**`); separators are `/`.
    Path,
    /// Network authorities (`host:port`); separators are `:` and `.`.
    Authority,
    /// Free-form text such as a command prefix; `*` matches anything.
    Raw,
}

impl MatchMode {
    fn separators(self) -> &'static [char] {
        match self {
            Self::Dotted => &['.'],
            Self::Path => &['/'],
            Self::Authority => &[':', '.'],
            Self::Raw => &[],
        }
    }
}

/// A compiled wildcard pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    raw: String,
    mode: MatchMode,
}

impl Pattern {
    /// Compiles a pattern for the given mode.
    ///
    /// # Errors
    /// Returns [`GuardError::Pattern`] for an empty pattern or one containing
    /// unsupported character-class syntax.
    pub fn compile(raw: &str, mode: MatchMode) -> Result<Self, GuardError> {
        if raw.is_empty() {
            return Err(GuardError::pattern(raw, "pattern must not be empty"));
        }
        if raw.contains(['[', ']', '{', '}']) {
            return Err(GuardError::pattern(
                raw,
                "character classes and brace alternation are not supported",
            ));
        }
        Ok(Self {
            raw: raw.to_owned(),
            mode,
        })
    }

    /// Returns the original pattern text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// Returns whether `value` matches this pattern.
    #[must_use]
    pub fn matches(&self, value: &str) -> bool {
        let pattern: Vec<char> = self.raw.chars().collect();
        let text: Vec<char> = value.chars().collect();
        glob(&pattern, &text, self.mode.separators())
    }
}

fn is_separator(ch: char, separators: &[char]) -> bool {
    separators.contains(&ch)
}

fn glob(pattern: &[char], text: &[char], separators: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => {
            if rest.first() == Some(&'*') {
                globstar(&rest[1..], text, separators)
            } else {
                star(rest, text, separators)
            }
        }
        Some(('?', rest)) => match text.split_first() {
            Some((ch, tail)) if !is_separator(*ch, separators) => glob(rest, tail, separators),
            _ => false,
        },
        Some((ch, rest)) => match text.split_first() {
            Some((head, tail)) if head == ch => glob(rest, tail, separators),
            _ => false,
        },
    }
}

/// `*`: zero or more characters within a single segment.
fn star(rest: &[char], text: &[char], separators: &[char]) -> bool {
    if glob(rest, text, separators) {
        return true;
    }
    for (index, ch) in text.iter().enumerate() {
        if is_separator(*ch, separators) {
            return false;
        }
        if glob(rest, &text[index + 1..], separators) {
            return true;
        }
    }
    false
}

/// `**`: zero or more characters spanning every segment.
fn globstar(rest: &[char], text: &[char], separators: &[char]) -> bool {
    // `**/` also matches zero directories, so allow the following separator to
    // be skipped entirely (`**/.env` matches `.env`).
    if let Some((separator, tail)) = rest.split_first()
        && is_separator(*separator, separators)
        && glob(tail, text, separators)
    {
        return true;
    }
    if glob(rest, text, separators) {
        return true;
    }
    for index in 0..text.len() {
        if glob(rest, &text[index + 1..], separators) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dotted(raw: &str) -> Pattern {
        Pattern::compile(raw, MatchMode::Dotted).unwrap()
    }

    fn path(raw: &str) -> Pattern {
        Pattern::compile(raw, MatchMode::Path).unwrap()
    }

    #[test]
    fn star_is_confined_to_a_segment() {
        let pattern = dotted("fs.*");
        assert!(pattern.matches("fs.read"));
        assert!(pattern.matches("fs.write"));
        assert!(!pattern.matches("fs.deep.read"));
    }

    #[test]
    fn globstar_spans_segments() {
        let pattern = path("src/**");
        assert!(pattern.matches("src/main.rs"));
        assert!(pattern.matches("src/a/b/c.rs"));
        assert!(!pattern.matches("tests/a.rs"));
    }

    #[test]
    fn globstar_matches_zero_segments() {
        assert!(path("**").matches("a/b/c"));
        assert!(path("**").matches(""));
        assert!(path("**/.env").matches(".env"));
        assert!(path("**/.env").matches("a/b/.env"));
    }

    #[test]
    fn command_prefix_is_raw() {
        let pattern = Pattern::compile("rm -rf*", MatchMode::Raw).unwrap();
        assert!(pattern.matches("rm -rf /"));
        assert!(pattern.matches("rm -rf"));
        assert!(!pattern.matches("sudo rm -rf /"));
    }

    #[test]
    fn authority_separators_are_respected() {
        let pattern = Pattern::compile("*.example:443", MatchMode::Authority).unwrap();
        assert!(pattern.matches("api.example:443"));
        assert!(!pattern.matches("api.example:80"));
    }

    #[test]
    fn malformed_patterns_are_rejected() {
        assert!(Pattern::compile("", MatchMode::Dotted).is_err());
        assert!(Pattern::compile("a[b]", MatchMode::Dotted).is_err());
    }
}
