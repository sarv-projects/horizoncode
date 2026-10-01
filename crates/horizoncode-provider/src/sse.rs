//! A minimal, incremental Server-Sent Events decoder.
//!
//! The adapter only needs `data:` payloads and the `[DONE]` sentinel; comments,
//! `event:` and `id:` fields are ignored. Decoding is byte-oriented so a chunk
//! boundary in the middle of a multi-byte character is safe: a line is only
//! decoded once its terminating newline arrives.

use horizoncode_types::ProviderError;

/// Maximum serialized SSE line bytes, including its newline when present.
pub(crate) const MAX_SSE_LINE_BYTES: usize = 1_048_576;

/// One decoded SSE frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SseFrame {
    /// A `data:` payload (without the prefix).
    Data(String),
    /// The `[DONE]` sentinel.
    Done,
}

/// Incremental SSE line decoder.
#[derive(Debug)]
pub struct SseBuffer {
    buffer: Vec<u8>,
    max_line_bytes: usize,
}

impl Default for SseBuffer {
    fn default() -> Self {
        Self::with_max_line_bytes(MAX_SSE_LINE_BYTES)
    }
}

impl SseBuffer {
    /// Creates an empty decoder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a decoder with a specific per-line byte ceiling.
    #[must_use]
    pub(crate) fn with_max_line_bytes(max_line_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_line_bytes,
        }
    }

    /// Feeds a chunk and returns every complete frame it produced.
    ///
    /// # Errors
    /// Returns a typed provider error for invalid UTF-8 or a line over the ceiling.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, ProviderError> {
        let mut frames = Vec::new();
        let mut start = 0;
        while start < chunk.len() {
            let newline = chunk[start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|offset| start + offset);
            let end = newline.unwrap_or(chunk.len());
            let appended_bytes = end - start + usize::from(newline.is_some());
            if self.buffer.len().saturating_add(appended_bytes) > self.max_line_bytes {
                return Err(ProviderError::response_limit(format!(
                    "provider response limit version 1: SSE line exceeds {} bytes",
                    self.max_line_bytes
                )));
            }
            self.buffer
                .extend_from_slice(&chunk[start..end + usize::from(newline.is_some())]);
            let Some(_) = newline else {
                break;
            };

            let mut line_end = self.buffer.len() - 1;
            // Drop the newline and an optional preceding carriage return.
            if line_end > 0 && self.buffer[line_end - 1] == b'\r' {
                line_end -= 1;
            }
            if let Some(frame) = decode_line(&self.buffer[..line_end])? {
                frames.push(frame);
            }
            self.buffer.clear();
            start = end + 1;
        }
        Ok(frames)
    }

    /// Flushes any trailing unterminated line.
    ///
    /// # Errors
    /// Returns a transport [`ProviderError`] when the trailing bytes are not
    /// valid UTF-8.
    pub fn finish(&mut self) -> Result<Vec<SseFrame>, ProviderError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let line: Vec<u8> = std::mem::take(&mut self.buffer);
        Ok(decode_line(&line)?.into_iter().collect())
    }
}

fn decode_line(line: &[u8]) -> Result<Option<SseFrame>, ProviderError> {
    if line.is_empty() || line.first() == Some(&b':') {
        return Ok(None);
    }
    let text = std::str::from_utf8(line).map_err(|error| {
        ProviderError::transport(format!("invalid utf-8 in sse stream: {error}"))
    })?;
    let Some(payload) = text.strip_prefix("data:") else {
        return Ok(None);
    };
    let payload = payload.strip_prefix(' ').unwrap_or(payload);
    if payload.trim() == "[DONE]" {
        return Ok(Some(SseFrame::Done));
    }
    if payload.is_empty() {
        return Ok(None);
    }
    Ok(Some(SseFrame::Data(payload.to_owned())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_frames_across_chunk_boundaries() {
        let mut buffer = SseBuffer::new();
        assert!(buffer.push(b"data: {\"a\":1}\n").unwrap().len() == 1);
        // A chunk that splits a line in two.
        let mut frames = buffer.push(b"da").unwrap();
        assert!(frames.is_empty());
        frames.extend(buffer.push(b"ta: {\"b\":2}\n").unwrap());
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], SseFrame::Data("{\"b\":2}".to_owned()));
    }

    #[test]
    fn recognizes_done_ignores_comments_and_events() {
        let mut buffer = SseBuffer::new();
        let frames = buffer
            .push(b": keep-alive\nevent: message\ndata: [DONE]\n")
            .unwrap();
        assert_eq!(frames, vec![SseFrame::Done]);
    }

    #[test]
    fn flushes_trailing_unterminated_line() {
        let mut buffer = SseBuffer::new();
        assert!(buffer.push(b"data: {\"x\":1}").unwrap().is_empty());
        assert_eq!(
            buffer.finish().unwrap(),
            vec![SseFrame::Data("{\"x\":1}".to_owned())]
        );
    }

    #[test]
    fn splits_multibyte_characters_safely() {
        let line = "data: café\n".as_bytes().to_vec();
        let (head, tail) = line.split_at(9);
        let mut buffer = SseBuffer::new();
        assert!(buffer.push(head).unwrap().is_empty());
        let frames = buffer.push(tail).unwrap();
        assert_eq!(frames, vec![SseFrame::Data("café".to_owned())]);
    }

    #[test]
    fn accepts_a_line_at_the_ceiling_and_rejects_one_byte_over() {
        let mut exact = SseBuffer::with_max_line_bytes(8);
        assert_eq!(
            exact.push(b"data:xx\n").unwrap(),
            vec![SseFrame::Data("xx".to_owned())]
        );

        let mut over = SseBuffer::with_max_line_bytes(8);
        let error = over.push(b"data:xxx\n").unwrap_err();
        assert_eq!(
            error.kind,
            horizoncode_types::ProviderErrorKind::ResponseLimit
        );
        assert!(
            over.buffer.len() <= 8,
            "buffered {} bytes",
            over.buffer.len()
        );
    }

    #[test]
    fn rejects_a_split_line_before_appending_the_over_limit_chunk() {
        let mut buffer = SseBuffer::with_max_line_bytes(8);
        assert!(buffer.push(b"data:").unwrap().is_empty());
        let error = buffer.push(b"1234\n").unwrap_err();
        assert_eq!(
            error.kind,
            horizoncode_types::ProviderErrorKind::ResponseLimit
        );
        assert_eq!(buffer.buffer, b"data:");
    }
}
