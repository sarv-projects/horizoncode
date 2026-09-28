//! The one JSONC reader.
//!
//! `ARCH/18` accepts JSONC for config documents. `serde_json` deliberately does
//! not, so this module strips `//` and `/* */` comments and trailing commas
//! without touching string contents. It is shared with `CMP-guard` rather than
//! copied, because two readers would be two places for an escape bug.
//!
//! The reader is syntax-only: validation is the caller's, and every caller
//! treats a returned error as a malformed layer (fail-safe, never a wider
//! default).

/// Strips `//` and `/* */` comments and trailing commas from JSONC.
///
/// # Errors
/// Returns a message for an unterminated block comment or string.
pub fn strip(input: &str) -> Result<String, String> {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let ch = bytes[index];
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = bytes.get(index + 1) {
                    out.push(*next);
                    index += 2;
                    continue;
                }
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
                index += 1;
            }
            '/' if bytes.get(index + 1) == Some(&'/') => {
                while index < bytes.len() && bytes[index] != '\n' {
                    index += 1;
                }
            }
            '/' if bytes.get(index + 1) == Some(&'*') => {
                index += 2;
                loop {
                    match (bytes.get(index), bytes.get(index + 1)) {
                        (Some('*'), Some('/')) => {
                            index += 2;
                            break;
                        }
                        (Some(_), _) => index += 1,
                        (None, _) => return Err("unterminated block comment".to_owned()),
                    }
                }
            }
            _ => {
                out.push(ch);
                index += 1;
            }
        }
    }
    if in_string {
        return Err("unterminated string".to_owned());
    }
    Ok(remove_trailing_commas(&out))
}

fn remove_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    let chars: Vec<char> = input.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if in_string {
            out.push(*ch);
            if escaped {
                // The previous character consumed an escape, so this one is data
                // whether or not it is a quote.
                escaped = false;
            } else if *ch == '\\' {
                escaped = true;
            } else if *ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(*ch);
            }
            ',' => {
                let next = chars[index + 1..]
                    .iter()
                    .find(|candidate| !candidate.is_whitespace());
                if matches!(next, Some('}') | Some(']')) {
                    // Drop the trailing comma.
                } else {
                    out.push(*ch);
                }
            }
            _ => out.push(*ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_escaped_quote_does_not_end_the_string() {
        // The trailing-comma pass ran its own string scan and, unlike the comment
        // pass, did not carry an escape: `\"` closed the string early, so a comma
        // inside the value was then treated as a trailing comma and deleted, and
        // the document stopped being valid JSON. The fixture values are encoded
        // with `serde_json` so the *document* is well-formed and only the
        // stripper can break it.
        for value in ["v\",}", "a\\", "say \"hi\", ok", "trailing\\", "\\\"", "x"] {
            let text = format!(
                r#"{{ "resource": {}, "effect": "deny", }}"#,
                serde_json::to_string(value).unwrap()
            );
            let stripped = strip(&text).unwrap_or_else(|e| panic!("{value:?}: {e}"));
            let parsed: serde_json::Value = serde_json::from_str(&stripped)
                .unwrap_or_else(|e| panic!("{value:?} did not survive stripping: {e}\n{stripped}"));
            assert_eq!(parsed["resource"], value, "{stripped}");
            assert_eq!(parsed["effect"], "deny", "{stripped}");
        }
    }

    #[test]
    fn a_backslash_escape_at_the_end_of_a_string_is_handled() {
        let value = "C:\\";
        let text = format!(
            r#"{{ "resource": {}, "effect": "ask", }}"#,
            serde_json::to_string(value).unwrap()
        );
        let stripped = strip(&text).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&stripped).unwrap_or_else(|e| panic!("{e}\n{stripped}"));
        assert_eq!(parsed["resource"], value);
    }

    #[test]
    fn a_comment_marker_inside_a_string_is_not_a_comment() {
        let value = "https://example.invalid/a//b";
        let text = format!(
            r#"{{ "resource": {}, "effect": "deny" /* a real comment */ }}"#,
            serde_json::to_string(value).unwrap()
        );
        let stripped = strip(&text).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&stripped).unwrap_or_else(|e| panic!("{e}\n{stripped}"));
        assert_eq!(parsed["resource"], value);
    }

    #[test]
    fn unterminated_constructs_are_errors() {
        assert!(strip("{ \"a\": \"unterminated }").is_err());
        assert!(strip("{ /* open }").is_err());
    }
}
