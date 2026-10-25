//! Bounded Content-Length framed JSON parser for supervised LSP/DAP stdio.
//!
//! The decoder accepts only a single ASCII `Content-Length` header and a
//! bounded UTF-8 JSON body. It retains incomplete bytes across polls; callers
//! must fence the process generation on any error because its stream boundary
//! can no longer be trusted.

use crate::messagepack::Value;

pub(crate) const MAX_PROTOCOL_FRAME_BYTES: usize = 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_JSON_NODES: usize = 32_768;
const MAX_JSON_DEPTH: usize = 32;

#[derive(Debug)]
pub(crate) enum FrameError {
    TooLarge,
    InvalidHeader,
    InvalidJson,
    JsonBounds,
}

#[derive(Default)]
pub(crate) struct ContentLengthDecoderV1 {
    pending: Vec<u8>,
}

impl ContentLengthDecoderV1 {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, FrameError> {
        if self.pending.len().saturating_add(bytes.len()) > MAX_PROTOCOL_FRAME_BYTES + MAX_HEADER_BYTES {
            return Err(FrameError::TooLarge);
        }
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            let Some(header_end) = find_header_end(&self.pending) else {
                if self.pending.len() > MAX_HEADER_BYTES { return Err(FrameError::InvalidHeader); }
                break;
            };
            if header_end > MAX_HEADER_BYTES { return Err(FrameError::InvalidHeader); }
            let body_length = parse_content_length(&self.pending[..header_end])?;
            if body_length == 0 || body_length > MAX_PROTOCOL_FRAME_BYTES { return Err(FrameError::TooLarge); }
            let body_start = header_end + 4;
            let body_end = body_start.checked_add(body_length).ok_or(FrameError::TooLarge)?;
            if body_end > self.pending.len() { break; }
            let body = std::str::from_utf8(&self.pending[body_start..body_end]).map_err(|_| FrameError::InvalidJson)?;
            let parsed = parse_json_without_duplicate_keys(body)?;
            let mut nodes = 0usize;
            if !within_json_bounds(&parsed, 0, &mut nodes) { return Err(FrameError::JsonBounds); }
            frames.push(to_wire_value(parsed)?);
            self.pending.drain(..body_end);
        }
        Ok(frames)
    }

    pub(crate) fn has_partial_frame(&self) -> bool { !self.pending.is_empty() }
}

fn parse_json_without_duplicate_keys(body: &str) -> Result<serde_json::Value, FrameError> {
    use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
    use std::fmt;

    struct UniqueJson;
    impl<'de> DeserializeSeed<'de> for UniqueJson {
        type Value = serde_json::Value;
        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where D: serde::Deserializer<'de> {
            deserializer.deserialize_any(UniqueVisitor)
        }
    }
    struct UniqueVisitor;
    impl<'de> Visitor<'de> for UniqueVisitor {
        type Value = serde_json::Value;
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("bounded JSON with unique object keys")
        }
        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> { Ok(value.into()) }
        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> { Ok(value.into()) }
        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> { Ok(value.into()) }
        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> where E: de::Error {
            serde_json::Number::from_f64(value).map(serde_json::Value::Number)
                .ok_or_else(|| de::Error::custom("non-finite JSON number"))
        }
        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> where E: de::Error {
            Ok(serde_json::Value::String(value.to_owned()))
        }
        fn visit_string<E>(self, value: String) -> Result<Self::Value, E> { Ok(value.into()) }
        fn visit_unit<E>(self) -> Result<Self::Value, E> { Ok(serde_json::Value::Null) }
        fn visit_none<E>(self) -> Result<Self::Value, E> { Ok(serde_json::Value::Null) }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where A: SeqAccess<'de> {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element_seed(UniqueJson)? { values.push(value); }
            Ok(serde_json::Value::Array(values))
        }
        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where A: MapAccess<'de> {
            let mut values = serde_json::Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if values.contains_key(&key) { return Err(de::Error::custom("duplicate JSON object key")); }
                let value = map.next_value_seed(UniqueJson)?;
                values.insert(key, value);
            }
            Ok(serde_json::Value::Object(values))
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(body);
    let value = UniqueJson.deserialize(&mut deserializer).map_err(|_| FrameError::InvalidJson)?;
    deserializer.end().map_err(|_| FrameError::InvalidJson)?;
    Ok(value)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Result<usize, FrameError> {
    let text = std::str::from_utf8(header).map_err(|_| FrameError::InvalidHeader)?;
    let mut content_length = None;
    for line in text.split("\r\n") {
        if line.is_empty() { continue; }
        let (name, value) = line.split_once(':').ok_or(FrameError::InvalidHeader)?;
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() { return Err(FrameError::InvalidHeader); }
            let raw = value.trim();
            if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit())
                || (raw.len() > 1 && raw.starts_with('0'))
            { return Err(FrameError::InvalidHeader); }
            content_length = Some(raw.parse::<usize>().map_err(|_| FrameError::TooLarge)?);
        } else if name.eq_ignore_ascii_case("content-type") {
            if value.len() > 256 || value.bytes().any(|byte| byte.is_ascii_control()) {
                return Err(FrameError::InvalidHeader);
            }
        } else {
            return Err(FrameError::InvalidHeader);
        }
    }
    content_length.ok_or(FrameError::InvalidHeader)
}

fn within_json_bounds(value: &serde_json::Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes = match nodes.checked_add(1) { Some(value) => value, None => return false };
    if *nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH { return false; }
    match value {
        serde_json::Value::Array(values) => values.iter().all(|value| within_json_bounds(value, depth + 1, nodes)),
        serde_json::Value::Object(values) => values.len() <= MAX_JSON_NODES
            && values.iter().all(|(key, value)| key.len() <= MAX_PROTOCOL_FRAME_BYTES && within_json_bounds(value, depth + 1, nodes)),
        serde_json::Value::String(value) => value.len() <= MAX_PROTOCOL_FRAME_BYTES,
        _ => true,
    }
}

fn to_wire_value(value: serde_json::Value) -> Result<Value, FrameError> {
    Ok(match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(value) => Value::Bool(value),
        serde_json::Value::Number(number) => {
            if let Some(value) = number.as_u64() { Value::Unsigned(value) }
            else if let Some(value) = number.as_i64() { Value::Signed(value) }
            else {
                let value = number.as_f64().ok_or(FrameError::InvalidJson)?;
                if !value.is_finite() { return Err(FrameError::InvalidJson); }
                Value::Float(value.to_bits())
            }
        }
        serde_json::Value::String(value) => Value::String(value),
        serde_json::Value::Array(values) => Value::Array(values.into_iter().map(to_wire_value).collect::<Result<_, _>>()?),
        serde_json::Value::Object(values) => Value::Map(values.into_iter().map(|(key, value)| Ok((key, to_wire_value(value)?))).collect::<Result<_, FrameError>>()?),
    })
}

pub(crate) fn wire_to_json(value: &Value) -> Result<serde_json::Value, FrameError> {
    Ok(match value {
        Value::Nil => serde_json::Value::Null,
        Value::Bool(value) => serde_json::Value::Bool(*value),
        Value::Unsigned(value) => serde_json::Value::Number((*value).into()),
        Value::Signed(value) => serde_json::Value::Number((*value).into()),
        Value::Float(bits) => serde_json::Number::from_f64(f64::from_bits(*bits))
            .map(serde_json::Value::Number).ok_or(FrameError::InvalidJson)?,
        Value::String(value) => serde_json::Value::String(value.clone()),
        Value::Binary(_) => return Err(FrameError::InvalidJson),
        Value::Array(values) => serde_json::Value::Array(values.iter().map(wire_to_json).collect::<Result<_, _>>()?),
        Value::Map(values) => serde_json::Value::Object(values.iter().map(|(key, value)| Ok((key.clone(), wire_to_json(value)?))).collect::<Result<_, FrameError>>()?),
    })
}

pub(crate) fn json_to_wire(value: serde_json::Value) -> Result<Value, FrameError> {
    let mut nodes = 0usize;
    if !within_json_bounds(&value, 0, &mut nodes) { return Err(FrameError::JsonBounds); }
    to_wire_value(value)
}
