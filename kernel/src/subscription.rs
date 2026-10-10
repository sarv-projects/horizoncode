//! Bounded owner-scoped durable event delivery with cursor acknowledgments.
//!
//! Producers must stop reading canonical history when `offer` reports backpressure and
//! resume from the same source cursor after an ACK. Cursor gaps or conflicts require the
//! caller to terminate with `RESNAPSHOT_REQUIRED`; acknowledgments never delete history.

use std::collections::VecDeque;
use std::fmt;

use crate::protocol::{
    CursorV1, ProtocolError, RpcControlV1, RpcEventV1, RpcMessageV1, validate_message,
};

pub const MAX_SUBSCRIPTION_WINDOW: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferResult {
    Queued,
    Duplicate,
    Backpressured,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckResult {
    Advanced { released: usize },
    Duplicate,
}

#[derive(Debug)]
pub enum SubscriptionError {
    Protocol(ProtocolError),
    InvalidCapacity,
    OwnerMismatch,
    SequenceGap { expected: u64, found: u64 },
    CursorConflict,
    AckNotDelivered,
    AckStale,
    SequenceOverflow,
}

impl fmt::Display for SubscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "invalid subscription message: {error}"),
            Self::InvalidCapacity => formatter.write_str("subscription window is outside 1..=256"),
            Self::OwnerMismatch => {
                formatter.write_str("subscription event belongs to another owner")
            }
            Self::SequenceGap { expected, found } => {
                write!(
                    formatter,
                    "subscription cursor gap: expected {expected}, found {found}"
                )
            }
            Self::CursorConflict => {
                formatter.write_str("subscription cursor conflicts with prior event")
            }
            Self::AckNotDelivered => {
                formatter.write_str("acknowledgment does not name a delivered event")
            }
            Self::AckStale => {
                formatter.write_str("acknowledgment moves behind the committed cursor")
            }
            Self::SequenceOverflow => formatter.write_str("subscription cursor sequence overflow"),
        }
    }
}

impl std::error::Error for SubscriptionError {}

impl From<ProtocolError> for SubscriptionError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

/// Holds no more than `capacity` queued plus unacknowledged events for one owner.
pub struct BoundedSubscription {
    subscription_id: String,
    owner_kind: String,
    owner_id: String,
    capacity: usize,
    acknowledged: CursorV1,
    last_enqueued: CursorV1,
    last_event: Option<RpcEventV1>,
    queued: VecDeque<RpcEventV1>,
    in_flight: VecDeque<CursorV1>,
}

impl BoundedSubscription {
    pub fn new(
        subscription_id: impl Into<String>,
        owner_kind: impl Into<String>,
        owner_id: impl Into<String>,
        after: CursorV1,
        capacity: usize,
    ) -> Result<Self, SubscriptionError> {
        if !(1..=MAX_SUBSCRIPTION_WINDOW).contains(&capacity) {
            return Err(SubscriptionError::InvalidCapacity);
        }
        let subscription_id = subscription_id.into();
        let owner_kind = owner_kind.into();
        let owner_id = owner_id.into();
        validate_message(&RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            subscription_id: subscription_id.clone(),
            owner_kind: owner_kind.clone(),
            owner_id: owner_id.clone(),
            after: Some(after.clone()),
        })))?;
        if after.owner_kind != owner_kind || after.owner_id != owner_id {
            return Err(SubscriptionError::OwnerMismatch);
        }
        Ok(Self {
            subscription_id,
            owner_kind,
            owner_id,
            capacity,
            acknowledged: after.clone(),
            last_enqueued: after,
            last_event: None,
            queued: VecDeque::new(),
            in_flight: VecDeque::new(),
        })
    }

    /// Queue exactly the next owner event, or report backpressure without advancing.
    pub fn offer(&mut self, event: RpcEventV1) -> Result<OfferResult, SubscriptionError> {
        validate_message(&RpcMessageV1::Event(Box::new(event.clone())))?;
        if event.subscription_id != self.subscription_id
            || event.cursor.owner_kind != self.owner_kind
            || event.cursor.owner_id != self.owner_id
        {
            return Err(SubscriptionError::OwnerMismatch);
        }
        let found = parse_sequence(&event.cursor)?;
        let previous = parse_sequence(&self.last_enqueued)?;
        if found == previous {
            return if self.last_event.as_ref() == Some(&event) {
                Ok(OfferResult::Duplicate)
            } else {
                Err(SubscriptionError::CursorConflict)
            };
        }
        let expected = previous
            .checked_add(1)
            .ok_or(SubscriptionError::SequenceOverflow)?;
        if found != expected {
            return Err(SubscriptionError::SequenceGap { expected, found });
        }
        if self.buffered() >= self.capacity {
            return Ok(OfferResult::Backpressured);
        }
        self.last_enqueued = event.cursor.clone();
        self.last_event = Some(event.clone());
        self.queued.push_back(event);
        Ok(OfferResult::Queued)
    }

    /// Move one queued event to the sent-but-unacknowledged set.
    pub fn next_event(&mut self) -> Option<RpcEventV1> {
        let event = self.queued.pop_front()?;
        self.in_flight.push_back(event.cursor.clone());
        Some(event)
    }

    /// Release a contiguous prefix of sent events. Repeating the latest ACK is safe.
    pub fn ack(&mut self, through: &CursorV1) -> Result<AckResult, SubscriptionError> {
        validate_message(&RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: self.subscription_id.clone(),
            through: through.clone(),
        })))?;
        if through.owner_kind != self.owner_kind || through.owner_id != self.owner_id {
            return Err(SubscriptionError::OwnerMismatch);
        }
        let requested = parse_sequence(through)?;
        let acknowledged = parse_sequence(&self.acknowledged)?;
        if requested == acknowledged {
            return if through == &self.acknowledged {
                Ok(AckResult::Duplicate)
            } else {
                Err(SubscriptionError::CursorConflict)
            };
        }
        if requested < acknowledged {
            return Err(SubscriptionError::AckStale);
        }
        let Some(index) = self
            .in_flight
            .iter()
            .position(|cursor| parse_sequence(cursor).ok() == Some(requested))
        else {
            return Err(SubscriptionError::AckNotDelivered);
        };
        if self.in_flight[index] != *through {
            return Err(SubscriptionError::CursorConflict);
        }
        let released = index + 1;
        for _ in 0..released {
            self.in_flight.pop_front();
        }
        self.acknowledged = through.clone();
        Ok(AckResult::Advanced { released })
    }

    pub fn buffered(&self) -> usize {
        self.queued.len() + self.in_flight.len()
    }

    pub fn available_capacity(&self) -> usize {
        self.capacity - self.buffered()
    }

    pub fn acknowledged_cursor(&self) -> &CursorV1 {
        &self.acknowledged
    }
}

fn parse_sequence(cursor: &CursorV1) -> Result<u64, SubscriptionError> {
    cursor.seq.parse().map_err(|_| {
        SubscriptionError::Protocol(ProtocolError(
            crate::protocol::ProtocolErrorKind::InvalidField {
                field: "cursor.seq",
                reason: "must be a canonical unsigned integer",
            },
        ))
    })
}
