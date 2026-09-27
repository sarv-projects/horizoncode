//! A minimal, incremental Server-Sent Events decoder.
//!
//! The adapter only needs `data:` payloads and the `[DONE]` sentinel; comments,
//! `event:` and `id:` fields are ignored. Decoding is byte-oriented so a chunk
//! boundary in the middle of a multi-byte character is safe: a line is only
//! decoded once its terminating newline arrives.

use horizoncode_types::ProviderError;

/// One decoded SSE frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SseFrame {
    /// A `data:` payload (without the prefix).
    Data(String),
    /// The `[DONE]` sentinel.
    Done,
}

/// Incremental SSE line decoder.
#[derive(Debug, Default)]
pub struct SseBuffer {
    buffer: Vec<u8>,
}

impl SseBuffer {
    /// Creates an empty decoder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns every complete frame it produced.
    ///
    /// # Errors
    /// Returns a transport [`ProviderError`] when a line is not valid UTF-8.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, ProviderError> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=newline).collect();
            // Drop the newline and an optional preceding carriage return.
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(frame) = decode_line(&line)? {
                frames.push(frame);
            }
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
}
