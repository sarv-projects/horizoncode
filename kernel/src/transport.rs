//! Bounded framing for the private kernel transport.
//!
//! A frame is a four-byte big-endian payload length followed by exactly that many
//! opaque payload bytes. The 8 MiB maximum applies to the complete encoded frame,
//! including its prefix. This module does not interpret or authenticate payloads,
//! negotiate a protocol, or implement RPC behavior.

use std::error::Error;
use std::fmt;
use std::io::{self, Read, Write};

/// Number of bytes in the big-endian payload-length prefix.
pub const FRAME_PREFIX_SIZE: usize = 4;

/// Maximum encoded frame size, including the length prefix.
pub const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;

/// Maximum payload size after accounting for the frame prefix.
pub const MAX_PAYLOAD_SIZE: usize = MAX_FRAME_SIZE - FRAME_PREFIX_SIZE;

/// Failures produced while reading or writing a bounded frame.
#[derive(Debug)]
pub enum FrameError {
    /// The underlying reader or writer failed for a reason other than interruption.
    Io(io::Error),
    /// EOF arrived after part of the four-byte length prefix.
    TruncatedPrefix { received: usize },
    /// EOF arrived before the declared payload was complete.
    TruncatedPayload { expected: usize, received: usize },
    /// The declared or supplied payload would exceed the encoded-frame limit.
    FrameTooLarge { length: usize, max: usize },
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "frame I/O failed: {error}"),
            Self::TruncatedPrefix { received } => write!(
                formatter,
                "frame length prefix ended after {received} of {FRAME_PREFIX_SIZE} bytes"
            ),
            Self::TruncatedPayload { expected, received } => write!(
                formatter,
                "frame payload ended after {received} of {expected} bytes"
            ),
            Self::FrameTooLarge { length, max } => write!(
                formatter,
                "frame payload length {length} exceeds maximum {max}"
            ),
        }
    }
}

impl Error for FrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::TruncatedPrefix { .. }
            | Self::TruncatedPayload { .. }
            | Self::FrameTooLarge { .. } => None,
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Reads one complete frame, leaving any following frame for the next call.
///
/// Returns `Ok(None)` only when EOF occurs before any byte of a new prefix. EOF
/// during a prefix or payload is reported as a typed truncation error. The payload
/// length is checked against [`MAX_PAYLOAD_SIZE`] before allocating or reading the
/// payload. Payload contents are returned unchanged and are not decoded.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut prefix = [0; FRAME_PREFIX_SIZE];
    let prefix_bytes = read_fully(reader, &mut prefix)?;
    if prefix_bytes == 0 {
        return Ok(None);
    }
    if prefix_bytes != FRAME_PREFIX_SIZE {
        return Err(FrameError::TruncatedPrefix {
            received: prefix_bytes,
        });
    }

    let payload_length = u32::from_be_bytes(prefix) as usize;
    if payload_length > MAX_PAYLOAD_SIZE {
        return Err(FrameError::FrameTooLarge {
            length: payload_length,
            max: MAX_PAYLOAD_SIZE,
        });
    }

    let mut payload = vec![0; payload_length];
    let received = read_fully(reader, &mut payload)?;
    if received != payload_length {
        return Err(FrameError::TruncatedPayload {
            expected: payload_length,
            received,
        });
    }

    Ok(Some(payload))
}

/// Writes one complete opaque-payload frame.
///
/// Oversized payloads are rejected before any bytes are written. A successful call
/// writes the prefix and all payload bytes, but does not flush the writer. If an
/// underlying write fails after making partial progress, the caller should abandon
/// the channel because a partial frame may remain in it.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> Result<(), FrameError> {
    if payload.len() > MAX_PAYLOAD_SIZE {
        return Err(FrameError::FrameTooLarge {
            length: payload.len(),
            max: MAX_PAYLOAD_SIZE,
        });
    }

    let prefix = (payload.len() as u32).to_be_bytes();
    writer.write_all(&prefix)?;
    writer.write_all(payload)?;
    Ok(())
}

fn read_fully<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize, FrameError> {
    let mut received = 0;
    while received < buffer.len() {
        match reader.read(&mut buffer[received..]) {
            Ok(0) => break,
            Ok(count) => received += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    Ok(received)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct ChunkedReader<R> {
        inner: R,
        max_chunk: usize,
        consumed: usize,
    }

    impl<R> ChunkedReader<R> {
        fn new(inner: R, max_chunk: usize) -> Self {
            Self {
                inner,
                max_chunk,
                consumed: 0,
            }
        }
    }

    impl<R: Read> Read for ChunkedReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let chunk_size = buffer.len().min(self.max_chunk);
            let count = self.inner.read(&mut buffer[..chunk_size])?;
            self.consumed += count;
            Ok(count)
        }
    }

    struct ChunkedWriter {
        bytes: Vec<u8>,
        max_chunk: usize,
    }

    impl ChunkedWriter {
        fn new(max_chunk: usize) -> Self {
            Self {
                bytes: Vec::new(),
                max_chunk,
            }
        }
    }

    impl Write for ChunkedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            let count = buffer.len().min(self.max_chunk);
            self.bytes.extend_from_slice(&buffer[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn reads_and_writes_zero_length_and_normal_frames() {
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &[]).unwrap();
        write_frame(&mut encoded, b"opaque payload").unwrap();

        assert_eq!(&encoded[..FRAME_PREFIX_SIZE], &[0, 0, 0, 0]);
        let mut reader = Cursor::new(encoded);
        assert_eq!(read_frame(&mut reader).unwrap(), Some(Vec::new()));
        assert_eq!(
            read_frame(&mut reader).unwrap(),
            Some(b"opaque payload".to_vec())
        );
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    #[test]
    fn accepts_the_maximum_encoded_frame_size() {
        let payload = vec![0xA5; MAX_PAYLOAD_SIZE];
        let mut encoded = Vec::with_capacity(MAX_FRAME_SIZE);
        write_frame(&mut encoded, &payload).unwrap();

        assert_eq!(encoded.len(), MAX_FRAME_SIZE);
        assert_eq!(
            u32::from_be_bytes(encoded[..FRAME_PREFIX_SIZE].try_into().unwrap()) as usize,
            MAX_PAYLOAD_SIZE
        );
        assert_eq!(
            read_frame(&mut Cursor::new(encoded)).unwrap(),
            Some(payload)
        );
    }

    #[test]
    fn rejects_one_byte_over_limit_before_reading_payload() {
        let over_limit = (MAX_PAYLOAD_SIZE + 1) as u32;
        let mut bytes = over_limit.to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0xCC; 8]);
        let mut reader = ChunkedReader::new(Cursor::new(bytes), FRAME_PREFIX_SIZE);

        let error = read_frame(&mut reader).unwrap_err();
        assert!(matches!(
            error,
            FrameError::FrameTooLarge {
                length,
                max: MAX_PAYLOAD_SIZE
            } if length == MAX_PAYLOAD_SIZE + 1
        ));
        assert_eq!(reader.consumed, FRAME_PREFIX_SIZE);

        let oversized_payload = vec![0; MAX_PAYLOAD_SIZE + 1];
        let mut writer = Vec::new();
        assert!(matches!(
            write_frame(&mut writer, &oversized_payload),
            Err(FrameError::FrameTooLarge {
                length,
                max: MAX_PAYLOAD_SIZE
            }) if length == MAX_PAYLOAD_SIZE + 1
        ));
        assert!(writer.is_empty());
    }

    #[test]
    fn distinguishes_truncated_prefix_and_clean_eof() {
        assert_eq!(read_frame(&mut Cursor::new([])).unwrap(), None);

        for received in 1..FRAME_PREFIX_SIZE {
            let mut reader = Cursor::new(vec![0; received]);
            assert!(matches!(
                read_frame(&mut reader),
                Err(FrameError::TruncatedPrefix { received: actual }) if actual == received
            ));
        }
    }

    #[test]
    fn detects_truncated_payload() {
        let mut bytes = 5_u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"ab");
        let mut reader = Cursor::new(bytes);

        assert!(matches!(
            read_frame(&mut reader),
            Err(FrameError::TruncatedPayload {
                expected: 5,
                received: 2
            })
        ));
    }

    #[test]
    fn handles_short_reads_and_writes() {
        let payload = b"delivered over short operations";
        let mut writer = ChunkedWriter::new(1);
        write_frame(&mut writer, payload).unwrap();

        let mut reader = ChunkedReader::new(Cursor::new(writer.bytes), 1);
        assert_eq!(read_frame(&mut reader).unwrap(), Some(payload.to_vec()));
        assert_eq!(reader.consumed, FRAME_PREFIX_SIZE + payload.len());
    }
}
