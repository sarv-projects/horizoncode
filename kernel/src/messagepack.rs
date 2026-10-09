//! Small strict MessagePack subset for the private kernel protocol.
//!
//! The parser accepts only the scalar, array, map, string, and binary forms used by
//! the v1 wire contracts. Extension values and non-finite floating point values are
//! rejected.
//! Both input bytes and decoded structure are bounded before container allocation.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

pub const MAX_NESTING_DEPTH: usize = 64;
pub const MAX_DECODED_NODES: usize = 32_768;
pub const MAX_COLLECTION_ITEMS: usize = 32_768;
pub const MAX_SCALAR_BYTES: usize = 1_048_576;
pub const MAX_ENCODED_VALUE_BYTES: usize = 8 * 1024 * 1024;

/// The owned subset of MessagePack values supported by `HzKernelRpcV1`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Nil,
    Bool(bool),
    Unsigned(u64),
    Signed(i64),
    /// Canonical IEEE-754 binary64 bits; non-finite values are rejected.
    Float(u64),
    String(String),
    Binary(Vec<u8>),
    Array(Vec<Value>),
    /// Protocol maps use string keys. `BTreeMap` makes encoded key order canonical.
    Map(BTreeMap<String, Value>),
}

/// Bounds applied before decoding or encoding an arbitrary value tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_encoded_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_collection_items: usize,
    pub max_scalar_bytes: usize,
}

pub const FRAME_LIMITS: Limits = Limits {
    max_encoded_bytes: MAX_ENCODED_VALUE_BYTES,
    max_depth: MAX_NESTING_DEPTH,
    max_nodes: MAX_DECODED_NODES,
    max_collection_items: MAX_COLLECTION_ITEMS,
    max_scalar_bytes: MAX_SCALAR_BYTES,
};

/// Errors are deterministic and contain no decoded payload contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    InputTooLarge { length: usize, max: usize },
    Truncated,
    TrailingBytes { remaining: usize },
    UnsupportedMarker { marker: u8 },
    NonFiniteFloat,
    NonCanonicalInteger,
    InvalidUtf8,
    NonStringMapKey,
    DuplicateMapKey,
    NestingLimit { max: usize },
    NodeLimit { max: usize },
    CollectionLimit { length: usize, max: usize },
    ScalarLimit { length: usize, max: usize },
    EncodedSizeOverflow,
    AllocationFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessagePackError(pub ErrorKind);

impl fmt::Display for MessagePackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            ErrorKind::InputTooLarge { length, max } => {
                write!(formatter, "MessagePack input length {length} exceeds {max}")
            }
            ErrorKind::Truncated => formatter.write_str("truncated MessagePack value"),
            ErrorKind::TrailingBytes { remaining } => {
                write!(
                    formatter,
                    "MessagePack value has {remaining} trailing bytes"
                )
            }
            ErrorKind::UnsupportedMarker { marker } => {
                write!(formatter, "unsupported MessagePack marker 0x{marker:02x}")
            }
            ErrorKind::NonFiniteFloat => formatter.write_str("non-finite MessagePack float"),
            ErrorKind::NonCanonicalInteger => {
                formatter.write_str("nonnegative integer must use the unsigned value variant")
            }
            ErrorKind::InvalidUtf8 => formatter.write_str("invalid UTF-8 in MessagePack string"),
            ErrorKind::NonStringMapKey => {
                formatter.write_str("MessagePack map key is not a string")
            }
            ErrorKind::DuplicateMapKey => formatter.write_str("duplicate MessagePack map key"),
            ErrorKind::NestingLimit { max } => {
                write!(formatter, "MessagePack nesting exceeds {max}")
            }
            ErrorKind::NodeLimit { max } => write!(formatter, "MessagePack nodes exceed {max}"),
            ErrorKind::CollectionLimit { length, max } => {
                write!(
                    formatter,
                    "MessagePack collection length {length} exceeds {max}"
                )
            }
            ErrorKind::ScalarLimit { length, max } => {
                write!(
                    formatter,
                    "MessagePack scalar length {length} exceeds {max}"
                )
            }
            ErrorKind::EncodedSizeOverflow => {
                formatter.write_str("MessagePack encoded size overflow")
            }
            ErrorKind::AllocationFailed => formatter.write_str("MessagePack allocation failed"),
        }
    }
}

impl Error for MessagePackError {}

fn error(kind: ErrorKind) -> MessagePackError {
    MessagePackError(kind)
}

/// Decodes exactly one MessagePack value and rejects trailing bytes.
pub fn decode(input: &[u8], limits: Limits) -> Result<Value, MessagePackError> {
    if input.len() > limits.max_encoded_bytes {
        return Err(error(ErrorKind::InputTooLarge {
            length: input.len(),
            max: limits.max_encoded_bytes,
        }));
    }

    let mut parser = Parser {
        input,
        offset: 0,
        nodes: 0,
        limits,
    };
    let value = parser.read_value(0)?;
    if parser.offset != input.len() {
        return Err(error(ErrorKind::TrailingBytes {
            remaining: input.len() - parser.offset,
        }));
    }
    Ok(value)
}

/// Encodes one value in deterministic map-key order under the supplied limits.
pub fn encode(value: &Value, limits: Limits) -> Result<Vec<u8>, MessagePackError> {
    let encoded_len = checked_encoded_len(value, limits)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(encoded_len)
        .map_err(|_| error(ErrorKind::AllocationFailed))?;
    write_value(value, &mut output);
    debug_assert_eq!(output.len(), encoded_len);
    Ok(output)
}

/// Returns the exact canonical encoded size after validating all structural bounds.
pub fn encoded_len(value: &Value, limits: Limits) -> Result<usize, MessagePackError> {
    checked_encoded_len(value, limits)
}

/// Decodes and re-encodes one value into the codec's canonical representation:
/// sorted string map keys, minimal scalar headers, unsigned nonnegative integers,
/// and binary64 floating-point values. Callers must derive semantic payload digests
/// from this result (after operation-schema normalization), never from frame bytes.
pub fn canonicalize(input: &[u8], limits: Limits) -> Result<Vec<u8>, MessagePackError> {
    let value = decode(input, limits)?;
    encode(&value, limits)
}

fn checked_encoded_len(value: &Value, limits: Limits) -> Result<usize, MessagePackError> {
    let mut nodes = 0;
    let length = value_len(value, 0, &mut nodes, limits)?;
    if length > limits.max_encoded_bytes {
        return Err(error(ErrorKind::InputTooLarge {
            length,
            max: limits.max_encoded_bytes,
        }));
    }
    Ok(length)
}

fn value_len(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    limits: Limits,
) -> Result<usize, MessagePackError> {
    if depth > limits.max_depth {
        return Err(error(ErrorKind::NestingLimit {
            max: limits.max_depth,
        }));
    }
    *nodes = nodes.checked_add(1).ok_or_else(|| {
        error(ErrorKind::NodeLimit {
            max: limits.max_nodes,
        })
    })?;
    if *nodes > limits.max_nodes {
        return Err(error(ErrorKind::NodeLimit {
            max: limits.max_nodes,
        }));
    }

    match value {
        Value::Nil | Value::Bool(_) => Ok(1),
        Value::Unsigned(number) => Ok(unsigned_len(*number)),
        Value::Signed(number) if *number < 0 => Ok(signed_len(*number)),
        Value::Signed(_) => Err(error(ErrorKind::NonCanonicalInteger)),
        Value::Float(bits) if f64::from_bits(*bits).is_finite() => Ok(9),
        Value::Float(_) => Err(error(ErrorKind::NonFiniteFloat)),
        Value::String(text) => {
            scalar_limit(text.len(), limits)?;
            checked_sum(string_header_len(text.len()), text.len())
        }
        Value::Binary(bytes) => {
            scalar_limit(bytes.len(), limits)?;
            checked_sum(binary_header_len(bytes.len()), bytes.len())
        }
        Value::Array(items) => {
            collection_limit(items.len(), limits)?;
            let mut length = array_header_len(items.len());
            for item in items {
                length = checked_sum(length, value_len(item, depth + 1, nodes, limits)?)?;
            }
            Ok(length)
        }
        Value::Map(entries) => {
            collection_limit(entries.len(), limits)?;
            let mut length = map_header_len(entries.len());
            for (key, item) in entries {
                scalar_limit(key.len(), limits)?;
                *nodes = nodes.checked_add(1).ok_or_else(|| {
                    error(ErrorKind::NodeLimit {
                        max: limits.max_nodes,
                    })
                })?;
                if *nodes > limits.max_nodes {
                    return Err(error(ErrorKind::NodeLimit {
                        max: limits.max_nodes,
                    }));
                }
                length = checked_sum(length, string_header_len(key.len()))?;
                length = checked_sum(length, key.len())?;
                length = checked_sum(length, value_len(item, depth + 1, nodes, limits)?)?;
            }
            Ok(length)
        }
    }
}

fn checked_sum(left: usize, right: usize) -> Result<usize, MessagePackError> {
    left.checked_add(right)
        .ok_or_else(|| error(ErrorKind::EncodedSizeOverflow))
}

fn scalar_limit(length: usize, limits: Limits) -> Result<(), MessagePackError> {
    if length > limits.max_scalar_bytes {
        return Err(error(ErrorKind::ScalarLimit {
            length,
            max: limits.max_scalar_bytes,
        }));
    }
    Ok(())
}

fn collection_limit(length: usize, limits: Limits) -> Result<(), MessagePackError> {
    if length > limits.max_collection_items {
        return Err(error(ErrorKind::CollectionLimit {
            length,
            max: limits.max_collection_items,
        }));
    }
    Ok(())
}

fn unsigned_len(value: u64) -> usize {
    match value {
        0..=0x7f => 1,
        0x80..=0xff => 2,
        0x100..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

fn signed_len(value: i64) -> usize {
    if value >= 0 {
        unsigned_len(value as u64)
    } else if value >= -32 {
        1
    } else if value >= i8::MIN as i64 {
        2
    } else if value >= i16::MIN as i64 {
        3
    } else if value >= i32::MIN as i64 {
        5
    } else {
        9
    }
}

fn string_header_len(length: usize) -> usize {
    match length {
        0..=31 => 1,
        32..=255 => 2,
        256..=65_535 => 3,
        _ => 5,
    }
}

fn binary_header_len(length: usize) -> usize {
    match length {
        0..=255 => 2,
        256..=65_535 => 3,
        _ => 5,
    }
}

fn array_header_len(length: usize) -> usize {
    match length {
        0..=15 => 1,
        16..=65_535 => 3,
        _ => 5,
    }
}

fn map_header_len(length: usize) -> usize {
    match length {
        0..=15 => 1,
        16..=65_535 => 3,
        _ => 5,
    }
}

fn write_value(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Nil => output.push(0xc0),
        Value::Bool(false) => output.push(0xc2),
        Value::Bool(true) => output.push(0xc3),
        Value::Unsigned(number) => write_unsigned(*number, output),
        Value::Signed(number) => write_signed(*number, output),
        Value::Float(bits) => {
            output.push(0xcb);
            output.extend_from_slice(&bits.to_be_bytes());
        }
        Value::String(text) => {
            write_string_header(text.len(), output);
            output.extend_from_slice(text.as_bytes());
        }
        Value::Binary(bytes) => {
            write_binary_header(bytes.len(), output);
            output.extend_from_slice(bytes);
        }
        Value::Array(items) => {
            write_array_header(items.len(), output);
            for item in items {
                write_value(item, output);
            }
        }
        Value::Map(entries) => {
            write_map_header(entries.len(), output);
            for (key, item) in entries {
                write_string(key, output);
                write_value(item, output);
            }
        }
    }
}

fn write_unsigned(value: u64, output: &mut Vec<u8>) {
    match value {
        0..=0x7f => output.push(value as u8),
        0x80..=0xff => output.extend_from_slice(&[0xcc, value as u8]),
        0x100..=0xffff => {
            output.push(0xcd);
            output.extend_from_slice(&(value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            output.push(0xce);
            output.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            output.push(0xcf);
            output.extend_from_slice(&value.to_be_bytes());
        }
    }
}

fn write_signed(value: i64, output: &mut Vec<u8>) {
    if value >= 0 {
        write_unsigned(value as u64, output);
    } else if value >= -32 {
        output.push(value as i8 as u8);
    } else if value >= i8::MIN as i64 {
        output.extend_from_slice(&[0xd0, value as i8 as u8]);
    } else if value >= i16::MIN as i64 {
        output.push(0xd1);
        output.extend_from_slice(&(value as i16).to_be_bytes());
    } else if value >= i32::MIN as i64 {
        output.push(0xd2);
        output.extend_from_slice(&(value as i32).to_be_bytes());
    } else {
        output.push(0xd3);
        output.extend_from_slice(&value.to_be_bytes());
    }
}

fn write_string_header(length: usize, output: &mut Vec<u8>) {
    match length {
        0..=31 => output.push(0xa0 | length as u8),
        32..=255 => output.extend_from_slice(&[0xd9, length as u8]),
        256..=65_535 => {
            output.push(0xda);
            output.extend_from_slice(&(length as u16).to_be_bytes());
        }
        _ => {
            output.push(0xdb);
            output.extend_from_slice(&(length as u32).to_be_bytes());
        }
    }
}

fn write_string(value: &str, output: &mut Vec<u8>) {
    write_string_header(value.len(), output);
    output.extend_from_slice(value.as_bytes());
}

fn write_binary_header(length: usize, output: &mut Vec<u8>) {
    match length {
        0..=255 => output.extend_from_slice(&[0xc4, length as u8]),
        256..=65_535 => {
            output.push(0xc5);
            output.extend_from_slice(&(length as u16).to_be_bytes());
        }
        _ => {
            output.push(0xc6);
            output.extend_from_slice(&(length as u32).to_be_bytes());
        }
    }
}

fn write_array_header(length: usize, output: &mut Vec<u8>) {
    match length {
        0..=15 => output.push(0x90 | length as u8),
        16..=65_535 => {
            output.push(0xdc);
            output.extend_from_slice(&(length as u16).to_be_bytes());
        }
        _ => {
            output.push(0xdd);
            output.extend_from_slice(&(length as u32).to_be_bytes());
        }
    }
}

fn write_map_header(length: usize, output: &mut Vec<u8>) {
    match length {
        0..=15 => output.push(0x80 | length as u8),
        16..=65_535 => {
            output.push(0xde);
            output.extend_from_slice(&(length as u16).to_be_bytes());
        }
        _ => {
            output.push(0xdf);
            output.extend_from_slice(&(length as u32).to_be_bytes());
        }
    }
}

struct Parser<'a> {
    input: &'a [u8],
    offset: usize,
    nodes: usize,
    limits: Limits,
}

impl Parser<'_> {
    fn read_signed(&self, value: i64) -> Result<Value, MessagePackError> {
        if value < 0 {
            Ok(Value::Signed(value))
        } else {
            Ok(Value::Unsigned(value as u64))
        }
    }

    fn read_value(&mut self, depth: usize) -> Result<Value, MessagePackError> {
        if depth > self.limits.max_depth {
            return Err(error(ErrorKind::NestingLimit {
                max: self.limits.max_depth,
            }));
        }
        self.add_node()?;
        let marker = self.read_byte()?;
        match marker {
            0x00..=0x7f => Ok(Value::Unsigned(marker as u64)),
            0xe0..=0xff => Ok(Value::Signed((marker as i8) as i64)),
            0x80..=0x8f => self.read_map((marker & 0x0f) as usize, depth),
            0x90..=0x9f => self.read_array((marker & 0x0f) as usize, depth),
            0xa0..=0xbf => self.read_string((marker & 0x1f) as usize),
            0xc0 => Ok(Value::Nil),
            0xc2 => Ok(Value::Bool(false)),
            0xc3 => Ok(Value::Bool(true)),
            0xc4 => {
                let length = self.read_u8()? as usize;
                self.read_binary(length)
            }
            0xc5 => {
                let length = self.read_u16()? as usize;
                self.read_binary(length)
            }
            0xc6 => {
                let length = self.read_u32()? as usize;
                self.read_binary(length)
            }
            0xca => {
                let bits =
                    u32::from_be_bytes(self.read_bytes(4)?.try_into().expect("checked length"));
                let value = f32::from_bits(bits);
                if !value.is_finite() {
                    return Err(error(ErrorKind::NonFiniteFloat));
                }
                Ok(Value::Float((value as f64).to_bits()))
            }
            0xcb => {
                let bits =
                    u64::from_be_bytes(self.read_bytes(8)?.try_into().expect("checked length"));
                if !f64::from_bits(bits).is_finite() {
                    return Err(error(ErrorKind::NonFiniteFloat));
                }
                Ok(Value::Float(bits))
            }
            0xcc => Ok(Value::Unsigned(self.read_u8()? as u64)),
            0xcd => Ok(Value::Unsigned(self.read_u16()? as u64)),
            0xce => Ok(Value::Unsigned(self.read_u32()? as u64)),
            0xcf => Ok(Value::Unsigned(self.read_u64()?)),
            0xd0 => {
                let value = self.read_i8()? as i64;
                self.read_signed(value)
            }
            0xd1 => {
                let value = self.read_i16()? as i64;
                self.read_signed(value)
            }
            0xd2 => {
                let value = self.read_i32()? as i64;
                self.read_signed(value)
            }
            0xd3 => {
                let value = self.read_i64()?;
                self.read_signed(value)
            }
            0xd9 => {
                let length = self.read_u8()? as usize;
                self.read_string(length)
            }
            0xda => {
                let length = self.read_u16()? as usize;
                self.read_string(length)
            }
            0xdb => {
                let length = self.read_u32()? as usize;
                self.read_string(length)
            }
            0xdc => {
                let length = self.read_u16()? as usize;
                self.read_array(length, depth)
            }
            0xdd => {
                let length = self.read_u32()? as usize;
                self.read_array(length, depth)
            }
            0xde => {
                let length = self.read_u16()? as usize;
                self.read_map(length, depth)
            }
            0xdf => {
                let length = self.read_u32()? as usize;
                self.read_map(length, depth)
            }
            _ => Err(error(ErrorKind::UnsupportedMarker { marker })),
        }
    }

    fn add_node(&mut self) -> Result<(), MessagePackError> {
        self.nodes = self.nodes.checked_add(1).ok_or_else(|| {
            error(ErrorKind::NodeLimit {
                max: self.limits.max_nodes,
            })
        })?;
        if self.nodes > self.limits.max_nodes {
            return Err(error(ErrorKind::NodeLimit {
                max: self.limits.max_nodes,
            }));
        }
        Ok(())
    }

    fn read_array(&mut self, length: usize, depth: usize) -> Result<Value, MessagePackError> {
        self.collection_limit(length)?;
        self.node_budget(length)?;
        let mut items = Vec::new();
        items
            .try_reserve_exact(length)
            .map_err(|_| error(ErrorKind::AllocationFailed))?;
        for _ in 0..length {
            items.push(self.read_value(depth + 1)?);
        }
        Ok(Value::Array(items))
    }

    fn read_map(&mut self, length: usize, depth: usize) -> Result<Value, MessagePackError> {
        self.collection_limit(length)?;
        let minimum_nodes = length.checked_mul(2).ok_or_else(|| {
            error(ErrorKind::NodeLimit {
                max: self.limits.max_nodes,
            })
        })?;
        self.node_budget(minimum_nodes)?;
        let mut entries = BTreeMap::new();
        for _ in 0..length {
            let key = match self.read_value(depth + 1)? {
                Value::String(key) => key,
                _ => return Err(error(ErrorKind::NonStringMapKey)),
            };
            let value = self.read_value(depth + 1)?;
            if entries.insert(key, value).is_some() {
                return Err(error(ErrorKind::DuplicateMapKey));
            }
        }
        Ok(Value::Map(entries))
    }

    fn read_string(&mut self, length: usize) -> Result<Value, MessagePackError> {
        self.scalar_limit(length)?;
        let bytes = self.read_bytes(length)?;
        let text = std::str::from_utf8(bytes).map_err(|_| error(ErrorKind::InvalidUtf8))?;
        Ok(Value::String(text.to_owned()))
    }

    fn read_binary(&mut self, length: usize) -> Result<Value, MessagePackError> {
        self.scalar_limit(length)?;
        Ok(Value::Binary(self.read_bytes(length)?.to_vec()))
    }

    fn collection_limit(&self, length: usize) -> Result<(), MessagePackError> {
        if length > self.limits.max_collection_items {
            return Err(error(ErrorKind::CollectionLimit {
                length,
                max: self.limits.max_collection_items,
            }));
        }
        Ok(())
    }

    fn node_budget(&self, additional: usize) -> Result<(), MessagePackError> {
        if self
            .nodes
            .checked_add(additional)
            .is_none_or(|total| total > self.limits.max_nodes)
        {
            return Err(error(ErrorKind::NodeLimit {
                max: self.limits.max_nodes,
            }));
        }
        Ok(())
    }

    fn scalar_limit(&self, length: usize) -> Result<(), MessagePackError> {
        if length > self.limits.max_scalar_bytes {
            return Err(error(ErrorKind::ScalarLimit {
                length,
                max: self.limits.max_scalar_bytes,
            }));
        }
        Ok(())
    }

    fn read_byte(&mut self) -> Result<u8, MessagePackError> {
        let byte = *self
            .input
            .get(self.offset)
            .ok_or_else(|| error(ErrorKind::Truncated))?;
        self.offset += 1;
        Ok(byte)
    }

    fn read_bytes(&mut self, length: usize) -> Result<&[u8], MessagePackError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| error(ErrorKind::Truncated))?;
        let bytes = self
            .input
            .get(self.offset..end)
            .ok_or_else(|| error(ErrorKind::Truncated))?;
        self.offset = end;
        Ok(bytes)
    }

    fn read_u8(&mut self) -> Result<u8, MessagePackError> {
        self.read_byte()
    }

    fn read_u16(&mut self) -> Result<u16, MessagePackError> {
        Ok(u16::from_be_bytes(
            self.read_bytes(2)?.try_into().expect("checked length"),
        ))
    }

    fn read_u32(&mut self) -> Result<u32, MessagePackError> {
        Ok(u32::from_be_bytes(
            self.read_bytes(4)?.try_into().expect("checked length"),
        ))
    }

    fn read_u64(&mut self) -> Result<u64, MessagePackError> {
        Ok(u64::from_be_bytes(
            self.read_bytes(8)?.try_into().expect("checked length"),
        ))
    }

    fn read_i8(&mut self) -> Result<i8, MessagePackError> {
        Ok(self.read_byte()? as i8)
    }

    fn read_i16(&mut self) -> Result<i16, MessagePackError> {
        Ok(i16::from_be_bytes(
            self.read_bytes(2)?.try_into().expect("checked length"),
        ))
    }

    fn read_i32(&mut self) -> Result<i32, MessagePackError> {
        Ok(i32::from_be_bytes(
            self.read_bytes(4)?.try_into().expect("checked length"),
        ))
    }

    fn read_i64(&mut self) -> Result<i64, MessagePackError> {
        Ok(i64::from_be_bytes(
            self.read_bytes(8)?.try_into().expect("checked length"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            max_encoded_bytes: 1024,
            max_depth: 4,
            max_nodes: 32,
            max_collection_items: 16,
            max_scalar_bytes: 64,
        }
    }

    #[test]
    fn round_trips_supported_values_and_canonicalizes_map_keys() {
        let mut map = BTreeMap::new();
        map.insert(
            "z".to_owned(),
            Value::Array(vec![Value::Nil, Value::Signed(-33)]),
        );
        map.insert("a".to_owned(), Value::Binary(vec![0, 1, 255]));
        let value = Value::Map(map);

        let encoded = encode(&value, limits()).unwrap();
        assert_eq!(encoded[0], 0x82);
        assert_eq!(decode(&encoded, limits()).unwrap(), value);
        assert_eq!(encoded_len(&value, limits()).unwrap(), encoded.len());
    }

    #[test]
    fn rejects_trailing_bytes_and_unsupported_markers() {
        assert_eq!(
            decode(&[0xc0, 0xc0], limits()).unwrap_err().0,
            ErrorKind::TrailingBytes { remaining: 1 }
        );
        assert_eq!(
            decode(&[0xc1], limits()).unwrap_err().0,
            ErrorKind::UnsupportedMarker { marker: 0xc1 }
        );
    }

    #[test]
    fn rejects_duplicate_and_non_string_map_keys() {
        assert_eq!(
            decode(&[0x82, 0xa1, b'a', 0xc0, 0xa1, b'a', 0xc0], limits())
                .unwrap_err()
                .0,
            ErrorKind::DuplicateMapKey
        );
        assert_eq!(
            decode(&[0x81, 0x01, 0xc0], limits()).unwrap_err().0,
            ErrorKind::NonStringMapKey
        );
    }

    #[test]
    fn rejects_input_scalar_collection_node_and_depth_overruns() {
        let small = Limits {
            max_encoded_bytes: 1,
            ..limits()
        };
        assert!(matches!(
            decode(&[0xc0, 0xc0], small).unwrap_err().0,
            ErrorKind::InputTooLarge { .. }
        ));

        let small_string = Limits {
            max_scalar_bytes: 2,
            ..limits()
        };
        assert_eq!(
            decode(&[0xa3, b'a', b'b', b'c'], small_string)
                .unwrap_err()
                .0,
            ErrorKind::ScalarLimit { length: 3, max: 2 }
        );

        let small_array = Limits {
            max_collection_items: 1,
            ..limits()
        };
        assert_eq!(
            decode(&[0x92, 0xc0, 0xc0], small_array).unwrap_err().0,
            ErrorKind::CollectionLimit { length: 2, max: 1 }
        );

        let few_nodes = Limits {
            max_nodes: 2,
            ..limits()
        };
        assert_eq!(
            decode(&[0x92, 0xc0, 0xc0], few_nodes).unwrap_err().0,
            ErrorKind::NodeLimit { max: 2 }
        );

        let shallow = Limits {
            max_depth: 1,
            ..limits()
        };
        assert_eq!(
            decode(&[0x91, 0x91, 0xc0], shallow).unwrap_err().0,
            ErrorKind::NestingLimit { max: 1 }
        );
    }

    #[test]
    fn rejects_truncated_invalid_utf8_and_oversized_declared_lengths() {
        assert_eq!(
            decode(&[0xd9], limits()).unwrap_err().0,
            ErrorKind::Truncated
        );
        assert_eq!(
            decode(&[0xa1, 0xff], limits()).unwrap_err().0,
            ErrorKind::InvalidUtf8
        );
        assert_eq!(
            decode(&[0xc6, 0xff, 0xff, 0xff, 0xff], limits())
                .unwrap_err()
                .0,
            ErrorKind::ScalarLimit {
                length: u32::MAX as usize,
                max: 64
            }
        );
    }

    #[test]
    fn encoder_applies_the_same_bounds_as_decoder() {
        let value = Value::Array(vec![Value::Nil, Value::Nil]);
        let too_few_nodes = Limits {
            max_nodes: 2,
            ..limits()
        };
        assert_eq!(
            encode(&value, too_few_nodes).unwrap_err().0,
            ErrorKind::NodeLimit { max: 2 }
        );
    }

    #[test]
    fn round_trips_finite_floats_and_rejects_non_finite_values() {
        for value in [
            Value::Float(1.25f64.to_bits()),
            Value::Float((-12.5f64).to_bits()),
        ] {
            let encoded = encode(&value, limits()).unwrap();
            assert_eq!(decode(&encoded, limits()).unwrap(), value);
        }
        let float32 = [0xca, 0x3f, 0xa0, 0, 0];
        assert_eq!(
            canonicalize(&float32, limits()).unwrap(),
            encode(&Value::Float(1.25f64.to_bits()), limits()).unwrap()
        );
        assert_eq!(
            decode(&[0xca, 0x7f, 0xc0, 0, 0], limits()).unwrap_err().0,
            ErrorKind::NonFiniteFloat
        );
        assert_eq!(
            encode(&Value::Float(f64::INFINITY.to_bits()), limits())
                .unwrap_err()
                .0,
            ErrorKind::NonFiniteFloat
        );
    }

    #[test]
    fn canonicalize_normalizes_map_order_integer_width_and_signed_positive_aliases() {
        let noncanonical = [0x82, 0xa1, b'b', 0xcc, 0x01, 0xa1, b'a', 0x02];
        let expected = [0x82, 0xa1, b'a', 0x02, 0xa1, b'b', 0x01];
        assert_eq!(canonicalize(&noncanonical, limits()).unwrap(), expected);
        assert_eq!(canonicalize(&[0xd0, 0x01], limits()).unwrap(), [0x01]);
        assert_eq!(
            encode(&Value::Signed(1), limits()).unwrap_err().0,
            ErrorKind::NonCanonicalInteger
        );
    }
}
