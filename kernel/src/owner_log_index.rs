//! Rebuildable, non-canonical indexes for OwnerLog V2.

use crate::owner_log::{
    CommitReceiptV1, Digest, OwnerHeadV2, OwnerIdentity, OwnerLogError, SegmentSummary,
    validate_private_file,
};
use crate::protocol::CursorV1;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

pub(crate) const INDEX_FILENAME: &str = "owner-index.sqlite";

const SQLITE_PAGE_CACHE_KIB: i64 = 2048;
const BLOOM_WORDS: usize = 131_072;
const BLOOM_HASHES: u64 = 7;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IndexedDelivery {
    pub(crate) receipt: CommitReceiptV1,
    pub(crate) segment_id: u64,
    pub(crate) start_offset: u64,
    pub(crate) end_offset: u64,
}

pub(crate) struct OwnerIndex {
    connection: Connection,
    delivery_filter: Option<DeliveryFilter>,
}

pub(crate) struct OwnerIndexRebuild<'a> {
    transaction: Transaction<'a>,
    delivery_filter: DeliveryFilter,
}

pub(crate) struct DeliveryFilter {
    words: Box<[u64]>,
}

impl DeliveryFilter {
    fn new() -> Self {
        Self {
            words: vec![0; BLOOM_WORDS].into_boxed_slice(),
        }
    }

    fn insert(&mut self, delivery_id: &str) {
        let hash = blake3::hash(delivery_id.as_bytes());
        let first = u64::from_le_bytes(hash.as_bytes()[..8].try_into().unwrap());
        let second = u64::from_le_bytes(hash.as_bytes()[8..16].try_into().unwrap()) | 1;
        let bit_count = (BLOOM_WORDS * u64::BITS as usize) as u64;
        for round in 0..BLOOM_HASHES {
            let bit = first.wrapping_add(round.wrapping_mul(second)) % bit_count;
            self.words[(bit / u64::BITS as u64) as usize] |= 1 << (bit % u64::BITS as u64);
        }
    }

    fn may_contain(&self, delivery_id: &str) -> bool {
        let hash = blake3::hash(delivery_id.as_bytes());
        let first = u64::from_le_bytes(hash.as_bytes()[..8].try_into().unwrap());
        let second = u64::from_le_bytes(hash.as_bytes()[8..16].try_into().unwrap()) | 1;
        let bit_count = (BLOOM_WORDS * u64::BITS as usize) as u64;
        (0..BLOOM_HASHES).all(|round| {
            let bit = first.wrapping_add(round.wrapping_mul(second)) % bit_count;
            self.words[(bit / u64::BITS as u64) as usize] & (1 << (bit % u64::BITS as u64)) != 0
        })
    }
}

impl OwnerIndex {
    pub(crate) fn open(directory: &Path) -> Result<Self, OwnerLogError> {
        let path = directory.join(INDEX_FILENAME);
        let connection = match open_connection(&path) {
            Ok(connection) => connection,
            Err(OwnerLogError::IndexUnavailable) => {
                recreate_index_file(&path)?;
                open_connection(&path)?
            }
            Err(error) => return Err(error),
        };
        if configure_and_create_schema(&connection).is_err() {
            drop(connection);
            recreate_index_file(&path)?;
            let connection = open_connection(&path)?;
            configure_and_create_schema(&connection)?;
            return Ok(Self {
                connection,
                delivery_filter: None,
            });
        }
        Ok(Self {
            connection,
            delivery_filter: None,
        })
    }

    pub(crate) fn begin_rebuild(&mut self) -> Result<OwnerIndexRebuild<'_>, OwnerLogError> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        transaction
            .execute_batch("DELETE FROM deliveries; DELETE FROM segments; DELETE FROM index_state;")
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        Ok(OwnerIndexRebuild {
            transaction,
            delivery_filter: DeliveryFilter::new(),
        })
    }

    pub(crate) fn may_contain_delivery(&self, delivery_id: &str) -> bool {
        self.delivery_filter
            .as_ref()
            .is_none_or(|filter| filter.may_contain(delivery_id))
    }

    pub(crate) fn set_delivery_filter(&mut self, delivery_filter: DeliveryFilter) {
        self.delivery_filter = Some(delivery_filter);
    }

    pub(crate) fn delivery(
        &self,
        delivery_id: &str,
        owner: &OwnerIdentity,
    ) -> Result<Option<IndexedDelivery>, OwnerLogError> {
        let row = self
            .connection
            .query_row(
                "SELECT command_digest, seq, event_digest, event_count, receipt_digest, segment_id, start_offset, end_offset FROM deliveries WHERE delivery_id = ?1",
                [delivery_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        let Some((
            command_digest,
            seq,
            event_digest,
            event_count,
            receipt_digest,
            segment_id,
            start_offset,
            end_offset,
        )) = row
        else {
            return Ok(None);
        };
        let seq = parse_index_u64(&seq)?;
        let event_count = parse_index_u64(&event_count)?;
        Ok(Some(IndexedDelivery {
            receipt: CommitReceiptV1 {
                delivery_id: delivery_id.to_owned(),
                command_digest,
                owner_cursor: CursorV1 {
                    owner_kind: owner.kind().to_owned(),
                    owner_id: owner.id().to_owned(),
                    seq: seq.to_string(),
                    event_digest,
                },
                event_count,
                receipt_digest,
            },
            segment_id: parse_index_u64(&segment_id)?,
            start_offset: parse_index_u64(&start_offset)?,
            end_offset: parse_index_u64(&end_offset)?,
        }))
    }

    pub(crate) fn segment_for_seq(
        &self,
        seq: u64,
    ) -> Result<Option<SegmentSummary>, OwnerLogError> {
        self.connection
            .query_row(
                "SELECT segment_id, committed_offset, first_seq, last_seq, record_count, last_event_digest, previous_seq, previous_digest, sealed FROM segments WHERE last_seq >= ?1 ORDER BY last_seq LIMIT 1",
                [sequence_key(seq)],
                decode_segment_row,
            )
            .optional()
            .map_err(|_| OwnerLogError::IndexUnavailable)
    }

    pub(crate) fn segment(&self, segment_id: u64) -> Result<Option<SegmentSummary>, OwnerLogError> {
        self.connection
            .query_row(
                "SELECT segment_id, committed_offset, first_seq, last_seq, record_count, last_event_digest, previous_seq, previous_digest, sealed FROM segments WHERE segment_id = ?1",
                [sequence_key(segment_id)],
                decode_segment_row,
            )
            .optional()
            .map_err(|_| OwnerLogError::IndexUnavailable)
    }

    pub(crate) fn next_segment(
        &self,
        segment_id: u64,
    ) -> Result<Option<SegmentSummary>, OwnerLogError> {
        self.connection
            .query_row(
                "SELECT segment_id, committed_offset, first_seq, last_seq, record_count, last_event_digest, previous_seq, previous_digest, sealed FROM segments WHERE segment_id > ?1 ORDER BY segment_id LIMIT 1",
                [sequence_key(segment_id)],
                decode_segment_row,
            )
            .optional()
            .map_err(|_| OwnerLogError::IndexUnavailable)
    }

    pub(crate) fn commit_batch(
        &mut self,
        previous_active_segment: Option<u64>,
        summary: SegmentSummary,
        delivery: &IndexedDelivery,
        head: &OwnerHeadV2,
    ) -> Result<(), OwnerLogError> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        if let Some(segment_id) = previous_active_segment {
            let changed = transaction
                .execute(
                    "UPDATE segments SET sealed = 1 WHERE segment_id = ?1",
                    [sequence_key(segment_id)],
                )
                .map_err(|_| OwnerLogError::IndexUnavailable)?;
            if changed != 1 {
                return Err(OwnerLogError::IndexUnavailable);
            }
        }
        insert_segment(&transaction, summary)?;
        insert_delivery(&transaction, delivery)?;
        insert_index_state(&transaction, head)?;
        transaction
            .commit()
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        if let Some(filter) = &mut self.delivery_filter {
            filter.insert(&delivery.receipt.delivery_id);
        }
        Ok(())
    }
}

impl OwnerIndexRebuild<'_> {
    pub(crate) fn insert_segment(&mut self, summary: SegmentSummary) -> Result<(), OwnerLogError> {
        insert_segment(&self.transaction, summary)
    }

    pub(crate) fn insert_delivery(
        &mut self,
        delivery: &IndexedDelivery,
    ) -> Result<(), OwnerLogError> {
        insert_delivery(&self.transaction, delivery)?;
        self.delivery_filter.insert(&delivery.receipt.delivery_id);
        Ok(())
    }

    pub(crate) fn finish(self, head: &OwnerHeadV2) -> Result<DeliveryFilter, OwnerLogError> {
        insert_index_state(&self.transaction, head)?;
        self.transaction
            .commit()
            .map_err(|_| OwnerLogError::IndexUnavailable)?;
        Ok(self.delivery_filter)
    }
}

fn open_connection(path: &Path) -> Result<Connection, OwnerLogError> {
    ensure_private_index_file(path)?;
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| OwnerLogError::IndexUnavailable)
}

fn configure_and_create_schema(connection: &Connection) -> Result<(), OwnerLogError> {
    connection
        .execute_batch(&format!(
            "PRAGMA journal_mode=DELETE;
             PRAGMA synchronous=OFF;
             PRAGMA cache_size=-{SQLITE_PAGE_CACHE_KIB};
             PRAGMA temp_store=MEMORY;
             DROP TABLE IF EXISTS index_state;
             DROP TABLE IF EXISTS deliveries;
             DROP TABLE IF EXISTS segments;
             CREATE TABLE segments (
               segment_id TEXT PRIMARY KEY,
               committed_offset TEXT NOT NULL,
               first_seq TEXT NOT NULL,
               last_seq TEXT NOT NULL,
               record_count TEXT NOT NULL,
               last_event_digest TEXT NOT NULL,
               previous_seq TEXT NOT NULL,
               previous_digest TEXT NOT NULL,
               sealed INTEGER NOT NULL CHECK (sealed IN (0, 1))
             ) WITHOUT ROWID;
             CREATE INDEX segments_by_last_seq ON segments(last_seq);
             CREATE TABLE deliveries (
               delivery_id TEXT PRIMARY KEY,
               command_digest TEXT NOT NULL,
               seq TEXT NOT NULL,
               event_digest TEXT NOT NULL,
               event_count TEXT NOT NULL,
               receipt_digest TEXT NOT NULL,
               segment_id TEXT NOT NULL,
               start_offset TEXT NOT NULL,
               end_offset TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE TABLE index_state (
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
               generation TEXT NOT NULL,
               committed_seq TEXT NOT NULL,
               committed_event_digest TEXT NOT NULL
             ) WITHOUT ROWID;
             PRAGMA user_version=1;"
        ))
        .map_err(|_| OwnerLogError::IndexUnavailable)
}

fn ensure_private_index_file(path: &Path) -> Result<(), OwnerLogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err(OwnerLogError::UnknownStorageEntry);
            }
            validate_private_file(path, &metadata)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_private_index_file(path),
        Err(error) => Err(OwnerLogError::Io {
            operation: "inspect owner lookup index",
            kind: error.kind(),
        }),
    }
}

fn create_private_index_file(path: &Path) -> Result<(), OwnerLogError> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .map(drop)
        .map_err(|error| OwnerLogError::Io {
            operation: "create owner lookup index",
            kind: error.kind(),
        })
}

fn recreate_index_file(path: &Path) -> Result<(), OwnerLogError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() {
            return Err(OwnerLogError::UnknownStorageEntry);
        }
        validate_private_file(path, &metadata)?;
        fs::remove_file(path).map_err(|error| OwnerLogError::Io {
            operation: "replace corrupt owner lookup index",
            kind: error.kind(),
        })?;
    }
    create_private_index_file(path)
}

fn insert_segment(
    transaction: &Transaction<'_>,
    summary: SegmentSummary,
) -> Result<(), OwnerLogError> {
    transaction
        .execute(
            "INSERT INTO segments (segment_id, committed_offset, first_seq, last_seq, record_count, last_event_digest, previous_seq, previous_digest, sealed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(segment_id) DO UPDATE SET committed_offset=excluded.committed_offset, first_seq=excluded.first_seq, last_seq=excluded.last_seq, record_count=excluded.record_count, last_event_digest=excluded.last_event_digest, previous_seq=excluded.previous_seq, previous_digest=excluded.previous_digest, sealed=excluded.sealed",
            params![
                sequence_key(summary.segment_id),
                summary.committed_offset.to_string(),
                sequence_key(summary.first_seq),
                sequence_key(summary.last_seq),
                summary.record_count.to_string(),
                summary.last_event_digest.to_hex(),
                sequence_key(summary.previous_seq),
                summary.previous_digest.to_hex(),
                i64::from(summary.sealed),
            ],
        )
        .map_err(|_| OwnerLogError::IndexUnavailable)?;
    Ok(())
}

fn insert_delivery(
    transaction: &Transaction<'_>,
    delivery: &IndexedDelivery,
) -> Result<(), OwnerLogError> {
    transaction
        .execute(
            "INSERT INTO deliveries (delivery_id, command_digest, seq, event_digest, event_count, receipt_digest, segment_id, start_offset, end_offset) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                delivery.receipt.delivery_id,
                delivery.receipt.command_digest,
                sequence_key(parse_index_u64(&delivery.receipt.owner_cursor.seq)?),
                delivery.receipt.owner_cursor.event_digest,
                delivery.receipt.event_count.to_string(),
                delivery.receipt.receipt_digest,
                sequence_key(delivery.segment_id),
                delivery.start_offset.to_string(),
                delivery.end_offset.to_string(),
            ],
        )
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(ref failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                OwnerLogError::CorruptCommittedLog(
                    "delivery ID appears more than once in committed history",
                )
            }
            _ => OwnerLogError::IndexUnavailable,
        })?;
    Ok(())
}

fn insert_index_state(
    transaction: &Transaction<'_>,
    head: &OwnerHeadV2,
) -> Result<(), OwnerLogError> {
    transaction
        .execute(
            "INSERT INTO index_state (singleton, generation, committed_seq, committed_event_digest) VALUES (1, ?1, ?2, ?3) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation, committed_seq=excluded.committed_seq, committed_event_digest=excluded.committed_event_digest",
            params![
                head.generation.to_string(),
                sequence_key(head.committed_seq),
                head.committed_event_digest.to_hex(),
            ],
        )
        .map_err(|_| OwnerLogError::IndexUnavailable)?;
    Ok(())
}

fn decode_segment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SegmentSummary> {
    let segment_id = parse_sql_u64(row.get(0)?)?;
    let committed_offset = parse_sql_u64(row.get(1)?)?;
    let first_seq = parse_sql_u64(row.get(2)?)?;
    let last_seq = parse_sql_u64(row.get(3)?)?;
    let record_count = parse_sql_u64(row.get(4)?)?;
    let last_event_digest =
        Digest::parse_hex(&row.get::<_, String>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let previous_seq = parse_sql_u64(row.get(6)?)?;
    let previous_digest =
        Digest::parse_hex(&row.get::<_, String>(7)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let sealed = row.get::<_, i64>(8)? != 0;
    Ok(SegmentSummary {
        segment_id,
        committed_offset,
        first_seq,
        last_seq,
        record_count,
        last_event_digest,
        previous_seq,
        previous_digest,
        sealed,
    })
}

fn parse_sql_u64(value: String) -> rusqlite::Result<u64> {
    value.parse().map_err(|_| rusqlite::Error::InvalidQuery)
}

fn parse_index_u64(value: &str) -> Result<u64, OwnerLogError> {
    value.parse().map_err(|_| OwnerLogError::IndexUnavailable)
}

fn sequence_key(value: u64) -> String {
    format!("{value:020}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rebuild_journal_is_disk_backed() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!(
            "horizon-owner-index-journal-{}-{timestamp}.sqlite",
            std::process::id()
        ));
        let connection = Connection::open(&path).unwrap();
        configure_and_create_schema(&connection).unwrap();
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        drop(connection);
        fs::remove_file(path).unwrap();
        assert_eq!(mode, "delete");
    }

    #[test]
    fn delivery_filter_is_fixed_size_and_has_no_false_negatives() {
        let mut filter = DeliveryFilter::new();
        let delivery_ids = (0..50_000)
            .map(|index| format!("delivery-{index}"))
            .collect::<Vec<_>>();
        for delivery_id in &delivery_ids {
            filter.insert(delivery_id);
        }
        assert_eq!(filter.words.len() * std::mem::size_of::<u64>(), 1024 * 1024);
        assert!(
            delivery_ids
                .iter()
                .all(|delivery_id| filter.may_contain(delivery_id))
        );
    }
}
