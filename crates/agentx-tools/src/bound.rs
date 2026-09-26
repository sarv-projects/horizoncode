//! Model-visible output bounding (`ARCH/10-TOOLS.md`).
//!
//! One tool must not exhaust the context window. Content within
//! `max_lines`/`max_bytes` passes through unchanged; otherwise the model
//! receives a head/marker/tail preview and the full content is spilled to a
//! managed output file whose path is returned for the UI (`REQ-TOOL-004`).

/// Bounds applied to model-visible text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputBounds {
    /// Maximum retained lines.
    pub max_lines: usize,
    /// Maximum retained bytes.
    pub max_bytes: usize,
}

impl Default for OutputBounds {
    fn default() -> Self {
        Self {
            max_lines: 2000,
            max_bytes: 51_200,
        }
    }
}

/// The result of bounding a text payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bounded {
    /// The (possibly previewed) text.
    pub text: String,
    /// Whether the text was shortened.
    pub truncated: bool,
    /// The original byte length.
    pub total_bytes: usize,
    /// The original line count.
    pub total_lines: usize,
}

/// Bounds `text`, substituting a head/marker/tail preview when it exceeds the
/// limits.
#[must_use]
pub fn bound(text: &str, bounds: &OutputBounds) -> Bounded {
    let total_bytes = text.len();
    let total_lines = text.lines().count();
    let over_lines = total_lines > bounds.max_lines;
    let over_bytes = total_bytes > bounds.max_bytes;
    if !over_lines && !over_bytes {
        return Bounded {
            text: text.to_owned(),
            truncated: false,
            total_bytes,
            total_lines,
        };
    }
    let head_budget = bounds.max_bytes * 6 / 10;
    let tail_budget = bounds.max_bytes * 3 / 10;
    let head = clamp_boundary(text, head_budget);
    let tail = clamp_boundary_rev(text, tail_budget);
    let marker = format!("\n… [truncated: {total_bytes} bytes / {total_lines} lines total] …\n");
    let mut preview = String::with_capacity(head + marker.len() + tail);
    preview.push_str(&text[..head]);
    preview.push_str(&marker);
    preview.push_str(&text[text.len() - tail..]);
    Bounded {
        text: preview,
        truncated: true,
        total_bytes,
        total_lines,
    }
}

fn clamp_boundary(text: &str, budget: usize) -> usize {
    let mut end = budget.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn clamp_boundary_rev(text: &str, budget: usize) -> usize {
    let mut start = text.len().saturating_sub(budget);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text.len() - start
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_small_content_through() {
        let bounds = OutputBounds::default();
        let result = bound("hello\nworld\n", &bounds);
        assert!(!result.truncated);
        assert_eq!(result.text, "hello\nworld\n");
        assert_eq!(result.total_lines, 2);
    }

    #[test]
    fn bounds_large_content_with_marker() {
        let text = (0..5000)
            .map(|index| format!("line {index}\n"))
            .collect::<String>();
        let bounds = OutputBounds {
            max_lines: 100,
            max_bytes: 1024,
        };
        let result = bound(&text, &bounds);
        assert!(result.truncated);
        assert!(result.text.contains("truncated:"));
        assert!(result.text.len() < text.len());
        assert!(result.text.starts_with("line 0\n"));
        assert!(result.text.trim_end().ends_with("line 4999"));
    }

    #[test]
    fn byte_bounds_respect_char_boundaries() {
        let text = "é".repeat(1000);
        let bounds = OutputBounds {
            max_lines: 10_000,
            max_bytes: 101,
        };
        let result = bound(&text, &bounds);
        assert!(result.truncated);
        // Building the preview must not panic on a char boundary.
        assert!(result.text.contains("truncated:"));
    }
}
