//! The composer-reference parser (`ARCH/27` §Composer references).
//!
//! A mention is a **reference** only when it carries a known namespace
//! delimiter: `@file:src/main.rs`, `@run:r_01`, `@skill:review`. Anything else
//! — a bare `@name`, an email address, an unknown namespace — stays literal
//! text. An unknown namespace or a malformed mention gets a non-blocking
//! diagnostic so the surface can explain it; the text itself is never rewritten
//! or removed here.
//!
//! A path with spaces is quoted: `@"file:src/my file.rs"`, with `\"` and `\\`
//! escapes inside the quotes. Unquoted mentions end at whitespace, so a trailing
//! period belongs to the value; quote when that matters.
//!
//! Parsing a reference is **not** resolution and **not** authority: this module
//! never opens a file, launches an agent, or reads a secret. Resolution belongs
//! to the registries named by each namespace (`ARCH/27`), and a mention can
//! never grant a permission.

/// A recognized reference namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReferenceNamespace {
    /// A visible, enabled agent profile.
    Agent,
    /// A repository-relative path.
    File,
    /// A durable run id.
    Run,
    /// An enabled skill.
    Skill,
    /// A repository symbol.
    Symbol,
    /// A durable task id.
    Task,
}

impl ReferenceNamespace {
    /// Every namespace, in a stable order.
    pub const ALL: &'static [Self] = &[
        Self::Agent,
        Self::File,
        Self::Run,
        Self::Skill,
        Self::Symbol,
        Self::Task,
    ];

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::File => "file",
            Self::Run => "run",
            Self::Skill => "skill",
            Self::Symbol => "symbol",
            Self::Task => "task",
        }
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|namespace| namespace.as_str() == value)
    }
}

/// One recognized reference, with its byte span in the source text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    /// The namespace.
    pub namespace: ReferenceNamespace,
    /// The value after the delimiter, unescaped and unquoted.
    pub value: String,
    /// The byte offset of the `@`.
    pub start: usize,
    /// The byte offset one past the end of the mention.
    pub end: usize,
}

/// A non-blocking problem with a mention-shaped token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// The byte offset of the `@`.
    pub start: usize,
    /// The byte offset one past the end of the token.
    pub end: usize,
    /// What the surface may explain.
    pub message: String,
}

/// The result of scanning a text for references.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    /// Recognized references, in source order.
    pub references: Vec<Reference>,
    /// Non-blocking diagnostics, in source order.
    pub diagnostics: Vec<Diagnostic>,
}

impl Scan {
    /// Whether the text contains at least one recognized reference.
    #[must_use]
    pub fn has_references(&self) -> bool {
        !self.references.is_empty()
    }
}

/// Scans `text` for composer references, leaving the text untouched.
#[must_use]
pub fn scan_references(text: &str) -> Scan {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut scan = Scan::default();
    let mut index = 0usize;
    while index < chars.len() {
        let (offset, ch) = chars[index];
        if ch != '@' {
            index += 1;
            continue;
        }
        // An odd run of backslashes escapes the `@`, keeping it literal; an
        // even run leaves the `@` meaningful.
        let mut backslashes = 0usize;
        let mut walk = index;
        while walk > 0 && chars[walk - 1].1 == '\\' {
            backslashes += 1;
            walk -= 1;
        }
        if backslashes % 2 == 1 {
            index += 1;
            continue;
        }
        // A mention starts at a boundary, so `user@host` is never one.
        if walk > 0 && !is_boundary(chars[walk - 1].1) {
            index += 1;
            continue;
        }

        if chars.get(index + 1).map(|(_, ch)| *ch) == Some('"') {
            let (value, next, closed) = read_quoted(&chars, index + 2);
            if !closed {
                scan.diagnostics.push(Diagnostic {
                    start: offset,
                    end: text.len(),
                    message: "unterminated quoted reference; the text is kept literally".to_owned(),
                });
                break;
            }
            let end = chars
                .get(next.saturating_sub(1))
                .map_or(text.len(), |(offset, ch)| offset + ch.len_utf8());
            classify(&mut scan, &value, offset, end);
            index = next;
            continue;
        }

        let mut cursor = index + 1;
        let mut token = String::new();
        while cursor < chars.len() && !chars[cursor].1.is_whitespace() {
            token.push(chars[cursor].1);
            cursor += 1;
        }
        let end = chars.get(cursor).map_or(text.len(), |(offset, _)| *offset);
        classify(&mut scan, &token, offset, end);
        index = cursor;
    }
    scan
}

fn is_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '(' | '[' | '{' | '"' | '\'' | '<' | '>' | ',')
}

/// Reads a quoted value, returning it with the index just past the closing
/// quote and whether the quote was closed.
fn read_quoted(chars: &[(usize, char)], mut index: usize) -> (String, usize, bool) {
    let mut value = String::new();
    while index < chars.len() {
        match chars[index].1 {
            '\\' if index + 1 < chars.len() => {
                value.push(chars[index + 1].1);
                index += 2;
            }
            '"' => return (value, index + 1, true),
            ch => {
                value.push(ch);
                index += 1;
            }
        }
    }
    (value, index, false)
}

fn classify(scan: &mut Scan, token: &str, start: usize, end: usize) {
    let Some((namespace, value)) = token.split_once(':') else {
        // No delimiter: not a mention at all. Literal text, no diagnostic.
        return;
    };
    if namespace.is_empty() || value.is_empty() {
        scan.diagnostics.push(Diagnostic {
            start,
            end,
            message: format!("malformed reference `@{token}`; expected `@<namespace>:<value>`"),
        });
        return;
    }
    match ReferenceNamespace::parse(namespace) {
        Some(namespace) => scan.references.push(Reference {
            namespace,
            value: value.to_owned(),
            start,
            end,
        }),
        None => scan.diagnostics.push(Diagnostic {
            start,
            end,
            message: format!(
                "unknown reference namespace `{namespace}`; known: agent, file, run, skill, symbol, task"
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_namespace_becomes_a_reference_with_its_span() {
        let text = "please read @file:src/main.rs now";
        let scan = scan_references(text);
        assert_eq!(scan.references.len(), 1);
        let reference = &scan.references[0];
        assert_eq!(reference.namespace, ReferenceNamespace::File);
        assert_eq!(reference.value, "src/main.rs");
        assert_eq!(&text[reference.start..reference.end], "@file:src/main.rs");
        assert!(scan.diagnostics.is_empty());
    }

    #[test]
    fn every_namespace_is_recognized() {
        let scan =
            scan_references("@agent:p1 @file:a.rs @run:r1 @skill:s1 @symbol:Mod::Item @task:t1");
        assert_eq!(scan.references.len(), 6);
        let namespaces: Vec<ReferenceNamespace> =
            scan.references.iter().map(|r| r.namespace).collect();
        assert_eq!(namespaces, ReferenceNamespace::ALL.to_vec());
        assert!(scan.diagnostics.is_empty());
    }

    #[test]
    fn a_quoted_mention_may_contain_spaces_and_escapes() {
        let text = r#"open @"file:src/my file.rs" and @"file:a\"b.rs""#;
        let scan = scan_references(text);
        assert_eq!(scan.references.len(), 2);
        assert_eq!(scan.references[0].value, "src/my file.rs");
        assert_eq!(scan.references[1].value, "a\"b.rs");
        assert!(scan.diagnostics.is_empty());
    }

    #[test]
    fn an_unknown_namespace_is_diagnosed_and_left_literal() {
        let text = "see @mystery:thing here";
        let scan = scan_references(text);
        assert!(scan.references.is_empty());
        assert_eq!(scan.diagnostics.len(), 1);
        assert!(
            scan.diagnostics[0]
                .message
                .contains("unknown reference namespace"),
            "{}",
            scan.diagnostics[0].message
        );
        assert_eq!(
            &text[scan.diagnostics[0].start..scan.diagnostics[0].end],
            "@mystery:thing"
        );
    }

    #[test]
    fn tokens_without_a_delimiter_are_silent_literal_text() {
        for text in [
            "hello @world",
            "mail me at a@b.com",
            "@filename",
            "user@host/path",
        ] {
            let scan = scan_references(text);
            assert!(scan.references.is_empty(), "{text}");
            assert!(
                scan.diagnostics.is_empty(),
                "{text}: {:?}",
                scan.diagnostics
            );
        }
    }

    #[test]
    fn a_malformed_mention_with_the_delimiter_is_diagnosed() {
        for text in ["@file:", "@:value"] {
            let scan = scan_references(text);
            assert!(scan.references.is_empty(), "{text}");
            assert_eq!(scan.diagnostics.len(), 1, "{text}");
            assert!(
                scan.diagnostics[0].message.contains("malformed reference"),
                "{}",
                scan.diagnostics[0].message
            );
        }
    }

    #[test]
    fn an_escaped_at_sign_stays_literal() {
        let scan = scan_references(r"write \@file:x literally");
        assert!(scan.references.is_empty());
        assert!(scan.diagnostics.is_empty());
        // Two backslashes do not escape the mention.
        let scan = scan_references(r"write \\@file:x as a reference");
        assert_eq!(scan.references.len(), 1);
    }

    #[test]
    fn an_unterminated_quote_is_diagnosed_and_stops_the_scan() {
        let text = r#"open @"file:src/main.rs"#;
        let scan = scan_references(text);
        assert!(scan.references.is_empty());
        assert_eq!(scan.diagnostics.len(), 1);
        assert!(
            scan.diagnostics[0].message.contains("unterminated"),
            "{}",
            scan.diagnostics[0].message
        );
    }

    #[test]
    fn spans_are_byte_offsets_even_after_multibyte_text() {
        let text = "é @file:a.rs";
        let scan = scan_references(text);
        assert_eq!(scan.references.len(), 1);
        let reference = &scan.references[0];
        assert_eq!(&text[reference.start..reference.end], "@file:a.rs");
    }
}
