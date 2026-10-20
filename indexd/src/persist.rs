//! Bounded persistence/transport frame for immutable base generations.
//!
//! This module performs **no filesystem I/O and no network I/O**. It encodes a
//! [`BaseGeneration`] into one deterministic, versioned, length-prefixed,
//! checksummed byte frame that a host owner can persist or transmit, and it
//! decodes that frame back into an identical generation.
//!
//! Decoding is the hostile-input boundary: every declared length is validated
//! against fixed library limits *before* any allocation or slice is taken, the
//! trailing checksum is verified before the payload is parsed, and trailing or
//! truncated bytes are rejected. A malformed frame can therefore never make the
//! decoder allocate beyond the fixed index bounds.
//!
//! The frame is a library-level primitive for the eventual `hz-indexd`
//! persistence/transport owner. It is not an IPC protocol, not an
//! authentication or authorization proof, and not a claim that persistence is
//! wired into a running service.

use crate::{
    validate_path, BaseGeneration, Digest, FileSnapshot, GenerationPins, IndexError, OpaquePin,
};
use crate::{
    MAX_BASE_CONTENT_BYTES, MAX_BASE_FILES, MAX_BASE_PATH_BYTES, MAX_FILE_BYTES, MAX_PATH_BYTES,
    MAX_PIN_BYTES,
};
use std::fmt;

/// Highest byte size this crate will ever decode into one generation frame.
///
/// The bound covers the maximum base content, the maximum aggregate base path
/// bytes, every opaque pin, fixed per-entry length prefixes, and the checksum
/// with slack. Callers may pass a smaller limit to [`GenerationPack::decode_with_limit`];
/// larger limits are clamped to this constant.
pub const DEFAULT_MAX_PACK_BYTES: usize = MAX_BASE_CONTENT_BYTES + MAX_BASE_PATH_BYTES + 1_048_576;

const MAGIC: &[u8; 4] = b"HZIP";
const VERSION: u8 = 1;
const CHECKSUM_BYTES: usize = 32;
const HEADER_BYTES: usize = MAGIC.len() + 1;
const PACK_DOMAIN: &[u8] = b"horizon.indexd.generation-pack.v1\0";

/// One encoded generation frame. Treat the bytes as opaque.
#[derive(Clone, Eq, PartialEq)]
pub struct GenerationPack {
    bytes: Vec<u8>,
}

impl fmt::Debug for GenerationPack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GenerationPack")
            .field("byte_len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl GenerationPack {
    /// Encode one immutable generation into a deterministic bounded frame.
    ///
    /// Equal generations encode to equal bytes: files are emitted in normalized
    /// path order and every field is length prefixed.
    pub fn from_generation(generation: &BaseGeneration) -> Result<Self, IndexError> {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &generation.pins().repository)?;
        match &generation.pins().workspace {
            Some(workspace) => {
                payload.push(1);
                write_pin(&mut payload, workspace)?;
            }
            None => payload.push(0),
        }
        write_pin(&mut payload, &generation.pins().revision_set)?;
        write_pin(&mut payload, &generation.pins().read_scope)?;
        write_pin(&mut payload, &generation.pins().read_policy)?;
        write_pin(&mut payload, &generation.pins().source_receipt)?;
        write_pin(&mut payload, &generation.pins().parser_set)?;

        write_len(&mut payload, generation.file_count())?;
        for (path, file) in &generation.files {
            write_len(&mut payload, path.len())?;
            payload.extend_from_slice(path.as_bytes());
            write_len(&mut payload, file.contents.len())?;
            payload.extend_from_slice(file.contents.as_bytes());
        }

        if payload.len().saturating_add(CHECKSUM_BYTES) > DEFAULT_MAX_PACK_BYTES {
            return Err(IndexError::PackTooLarge {
                limit: DEFAULT_MAX_PACK_BYTES,
            });
        }
        let checksum = hash_pack(&payload);
        payload.extend_from_slice(checksum.as_bytes());
        Ok(Self { bytes: payload })
    }

    /// The bounded opaque frame bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Wrap already-encoded frame bytes without parsing them.
    ///
    /// The transport framing layer uses this to carry a pack it has not validated:
    /// a build request that fails pack validation must produce a typed error
    /// response, not a framing failure. This constructor therefore enforces only
    /// the outer byte bound; [`GenerationPack::decode`] remains the semantic
    /// boundary and the hostile-input boundary.
    pub fn from_encoded(bytes: impl Into<Vec<u8>>) -> Result<Self, IndexError> {
        let bytes = bytes.into();
        if bytes.len() > DEFAULT_MAX_PACK_BYTES {
            return Err(IndexError::PackTooLarge {
                limit: DEFAULT_MAX_PACK_BYTES,
            });
        }
        Ok(Self { bytes })
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Decode a frame at the crate's hard limit.
    pub fn decode(bytes: &[u8]) -> Result<BaseGeneration, IndexError> {
        Self::decode_with_limit(bytes, DEFAULT_MAX_PACK_BYTES)
    }

    /// Decode a frame under an explicit caller limit, clamped to the hard limit.
    ///
    /// The checksum is verified before the payload is parsed; every declared
    /// length is bounded before its bytes are taken.
    pub fn decode_with_limit(bytes: &[u8], max_bytes: usize) -> Result<BaseGeneration, IndexError> {
        let limit = max_bytes.min(DEFAULT_MAX_PACK_BYTES);
        if bytes.len() > limit {
            return Err(IndexError::PackTooLarge { limit });
        }
        if bytes.len() < HEADER_BYTES + CHECKSUM_BYTES {
            return Err(IndexError::InvalidPackEncoding);
        }
        let (payload, checksum_field) = bytes.split_at(bytes.len() - CHECKSUM_BYTES);
        if hash_pack(payload).as_bytes().as_slice() != checksum_field {
            return Err(IndexError::PackChecksumMismatch);
        }

        let mut cursor = Cursor::new(payload);
        if cursor.take(MAGIC.len())? != MAGIC {
            return Err(IndexError::InvalidPackEncoding);
        }
        if cursor.take(1)?[0] != VERSION {
            return Err(IndexError::InvalidPackEncoding);
        }

        let repository = decode_pin(&mut cursor)?;
        let workspace = match cursor.take(1)?[0] {
            0 => None,
            1 => Some(decode_pin(&mut cursor)?),
            _ => return Err(IndexError::InvalidPackEncoding),
        };
        let pins = GenerationPins {
            repository,
            workspace,
            revision_set: decode_pin(&mut cursor)?,
            read_scope: decode_pin(&mut cursor)?,
            read_policy: decode_pin(&mut cursor)?,
            source_receipt: decode_pin(&mut cursor)?,
            parser_set: decode_pin(&mut cursor)?,
        };

        let file_count = cursor.take_len()?;
        if file_count > MAX_BASE_FILES {
            return Err(IndexError::TooManyBaseFiles {
                limit: MAX_BASE_FILES,
            });
        }

        let mut path_bytes = 0usize;
        let mut content_bytes = 0usize;
        let mut snapshots = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let path_len = cursor.take_len()?;
            if path_len > MAX_PATH_BYTES {
                return Err(IndexError::InvalidPackEncoding);
            }
            path_bytes = path_bytes
                .checked_add(path_len)
                .filter(|total| *total <= MAX_BASE_PATH_BYTES)
                .ok_or(IndexError::BasePathLimit {
                    limit: MAX_BASE_PATH_BYTES,
                })?;
            let path = match std::str::from_utf8(cursor.take(path_len)?) {
                Ok(path) => path.to_owned(),
                Err(_) => return Err(IndexError::InvalidPackEncoding),
            };
            validate_path(&path)?;

            let content_len = cursor.take_len()?;
            if content_len > MAX_FILE_BYTES {
                return Err(IndexError::FileTooLarge {
                    path,
                    limit: MAX_FILE_BYTES,
                });
            }
            content_bytes = content_bytes
                .checked_add(content_len)
                .filter(|total| *total <= MAX_BASE_CONTENT_BYTES)
                .ok_or(IndexError::BaseContentLimit {
                    limit: MAX_BASE_CONTENT_BYTES,
                })?;
            snapshots.push(FileSnapshot {
                path,
                contents: cursor.take(content_len)?.to_vec(),
            });
        }

        if cursor.remaining() != 0 {
            return Err(IndexError::InvalidPackEncoding);
        }

        BaseGeneration::build(pins, snapshots)
    }
}

fn write_len(buffer: &mut Vec<u8>, length: usize) -> Result<(), IndexError> {
    let length = u32::try_from(length).map_err(|_| IndexError::InvalidPackEncoding)?;
    buffer.extend_from_slice(&length.to_be_bytes());
    Ok(())
}

fn write_pin(buffer: &mut Vec<u8>, pin: &OpaquePin) -> Result<(), IndexError> {
    write_len(buffer, pin.as_bytes().len())?;
    buffer.extend_from_slice(pin.as_bytes());
    Ok(())
}

fn decode_pin(cursor: &mut Cursor<'_>) -> Result<OpaquePin, IndexError> {
    let length = cursor.take_len()?;
    if length > MAX_PIN_BYTES {
        return Err(IndexError::PinTooLarge {
            limit: MAX_PIN_BYTES,
        });
    }
    OpaquePin::new(cursor.take(length)?.to_vec())
}

fn hash_pack(payload: &[u8]) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PACK_DOMAIN);
    hasher.update(payload);
    Digest::from_hasher(hasher)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], IndexError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(IndexError::InvalidPackEncoding)?;
        if end > self.bytes.len() {
            return Err(IndexError::InvalidPackEncoding);
        }
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn take_len(&mut self) -> Result<usize, IndexError> {
        let raw: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| IndexError::InvalidPackEncoding)?;
        Ok(u32::from_be_bytes(raw) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(value: &str) -> OpaquePin {
        OpaquePin::new(value.as_bytes().to_vec()).expect("valid pin")
    }

    fn pins() -> GenerationPins {
        GenerationPins {
            repository: pin("repo-1"),
            workspace: None,
            revision_set: pin("rev-1"),
            read_scope: pin("scope-1"),
            read_policy: pin("policy-1"),
            source_receipt: pin("receipt-1"),
            parser_set: pin("parser-1"),
        }
    }

    /// Build a checksummed frame from raw payload bytes so negative structural
    /// cases can exercise the decoder past the checksum gate.
    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut framed = payload.to_vec();
        let checksum = hash_pack(payload);
        framed.extend_from_slice(checksum.as_bytes());
        framed
    }

    fn valid_payload() -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, 1).expect("len");
        write_len(&mut payload, 3).expect("len");
        payload.extend_from_slice(b"a.b");
        write_len(&mut payload, 5).expect("len");
        payload.extend_from_slice(b"hello");
        payload
    }

    #[test]
    fn valid_payload_decodes_after_checksum_verification() {
        let decoded = GenerationPack::decode(&frame(&valid_payload())).expect("decode");
        assert_eq!(decoded.file_count(), 1);
        assert_eq!(decoded.content_bytes(), 5);
    }

    #[test]
    fn bad_magic_is_rejected_even_with_a_valid_checksum() {
        let mut payload = valid_payload();
        payload[0] = b'X';
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPackEncoding)
        ));
    }

    #[test]
    fn bad_version_is_rejected_even_with_a_valid_checksum() {
        let mut payload = valid_payload();
        payload[MAGIC.len()] = VERSION + 1;
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPackEncoding)
        ));
    }

    #[test]
    fn oversized_file_count_is_rejected_before_allocation() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, MAX_BASE_FILES + 1).expect("len");
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::TooManyBaseFiles { .. })
        ));
    }

    #[test]
    fn oversized_pin_declaration_is_rejected() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_len(&mut payload, MAX_PIN_BYTES + 1).expect("len");
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::PinTooLarge { .. })
        ));
    }

    #[test]
    fn oversized_file_declaration_is_rejected() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, 1).expect("len");
        write_len(&mut payload, 3).expect("len");
        payload.extend_from_slice(b"a.b");
        write_len(&mut payload, MAX_FILE_BYTES + 1).expect("len");
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn oversized_path_declaration_is_rejected() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, 1).expect("len");
        write_len(&mut payload, MAX_PATH_BYTES + 1).expect("len");
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPackEncoding)
        ));
    }

    #[test]
    fn non_utf8_path_is_rejected() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, 1).expect("len");
        write_len(&mut payload, 2).expect("len");
        payload.extend_from_slice(&[0xff, 0xfe]);
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPackEncoding)
        ));
    }

    #[test]
    fn invalid_normalized_path_is_rejected() {
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        write_pin(&mut payload, &pins().repository).expect("pin");
        payload.push(0);
        write_pin(&mut payload, &pins().revision_set).expect("pin");
        write_pin(&mut payload, &pins().read_scope).expect("pin");
        write_pin(&mut payload, &pins().read_policy).expect("pin");
        write_pin(&mut payload, &pins().source_receipt).expect("pin");
        write_pin(&mut payload, &pins().parser_set).expect("pin");
        write_len(&mut payload, 1).expect("len");
        write_len(&mut payload, 6).expect("len");
        payload.extend_from_slice(b"../a.b");
        write_len(&mut payload, 0).expect("len");
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPath(_))
        ));
    }

    #[test]
    fn trailing_payload_bytes_are_rejected() {
        let mut payload = valid_payload();
        payload.push(0);
        assert!(matches!(
            GenerationPack::decode(&frame(&payload)),
            Err(IndexError::InvalidPackEncoding)
        ));
    }

    #[test]
    fn truncated_content_is_rejected() {
        let payload = valid_payload();
        let truncated = &payload[..payload.len() - 1];
        assert!(GenerationPack::decode(&frame(truncated)).is_err());
    }

    #[test]
    fn from_encoded_wraps_any_bounded_bytes_without_validating_them() {
        let garbage = GenerationPack::from_encoded(vec![0u8; 64]).expect("bounded wrap");
        assert_eq!(garbage.len(), 64);
        assert!(matches!(
            GenerationPack::decode(garbage.as_bytes()),
            Err(IndexError::PackChecksumMismatch)
        ));

        let oversized = vec![0u8; DEFAULT_MAX_PACK_BYTES + 1];
        assert!(matches!(
            GenerationPack::from_encoded(oversized),
            Err(IndexError::PackTooLarge {
                limit: DEFAULT_MAX_PACK_BYTES
            })
        ));

        let original = BaseGeneration::build(
            pins(),
            vec![FileSnapshot::new("a.txt", b"needle\n".to_vec())],
        )
        .unwrap();
        let pack = GenerationPack::from_generation(&original).unwrap();
        let wrapped = GenerationPack::from_encoded(pack.as_bytes().to_vec()).expect("wrap");
        assert_eq!(
            GenerationPack::decode(wrapped.as_bytes())
                .expect("decode")
                .digest(),
            original.digest()
        );
    }
}
