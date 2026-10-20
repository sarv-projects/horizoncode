//! Opt-in, bounded persistence for immutable rebuildable generations.
//!
//! This is cache storage only. It does not authorize a workspace, prove that its
//! pins are trusted, or make an index current. The embedding HostKernel owner must
//! choose a private cache root for the authenticated principal/workspace/policy
//! scope, revalidate that authority before reuse, and keep exactly one store owner
//! per root. Source remains canonical; every entry can be deleted and rebuilt.

use crate::{BaseGeneration, Digest, GenerationPack, IndexError, DEFAULT_MAX_PACK_BYTES};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

pub const DEFAULT_MAX_PERSISTED_GENERATIONS: usize = 8;
pub const DEFAULT_MAX_PERSISTED_BYTES: usize = 134_217_728;
const MAX_PERSISTED_GENERATIONS: usize = 128;
const MAX_PERSISTED_BYTES: usize = 536_870_912;
const MAX_SCANNED_FILES: usize = 512;
const MAX_SCANNED_PACK_BYTES: usize = MAX_PERSISTED_BYTES;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationStoreLimits {
    pub max_generations: usize,
    pub max_bytes: usize,
}

impl Default for GenerationStoreLimits {
    fn default() -> Self {
        Self {
            max_generations: DEFAULT_MAX_PERSISTED_GENERATIONS,
            max_bytes: DEFAULT_MAX_PERSISTED_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationStoreStats {
    pub generations: usize,
    pub bytes: usize,
}

#[derive(Debug)]
pub enum GenerationStoreError {
    Io(std::io::Error),
    InvalidLimits,
    InvalidRoot,
    ScanLimit {
        limit: usize,
    },
    ScanByteLimit {
        limit_bytes: usize,
    },
    EntryExceedsBudget {
        entry_bytes: usize,
        budget_bytes: usize,
    },
    InvalidPack(IndexError),
}

impl fmt::Display for GenerationStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "generation cache I/O failed: {error}"),
            Self::InvalidLimits => formatter.write_str("generation cache limits are invalid"),
            Self::InvalidRoot => {
                formatter.write_str("generation cache root must be a real directory")
            }
            Self::ScanLimit { limit } => {
                write!(formatter, "generation cache scan exceeds {limit} entries")
            }
            Self::ScanByteLimit { limit_bytes } => write!(
                formatter,
                "generation cache scan exceeds {limit_bytes} pack bytes"
            ),
            Self::EntryExceedsBudget {
                entry_bytes,
                budget_bytes,
            } => write!(
                formatter,
                "generation pack ({entry_bytes} bytes) exceeds cache budget ({budget_bytes} bytes)"
            ),
            Self::InvalidPack(error) => {
                write!(formatter, "generation cache pack is invalid: {error}")
            }
        }
    }
}

impl Error for GenerationStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidPack(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for GenerationStoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Clone)]
struct Entry {
    path: PathBuf,
    bytes: usize,
    modified: SystemTime,
}

/// One owner-managed, filesystem-backed cache of immutable generation packs.
///
/// Methods require `&mut self` so one instance serializes updates. Callers must
/// not open multiple owners on the same root concurrently. The cache has no
/// locking or authority role; a host owner must namespace and protect its root.
pub struct PersistentGenerationStore {
    root: PathBuf,
    limits: GenerationStoreLimits,
    entries: BTreeMap<Digest, Entry>,
    bytes: usize,
}

impl PersistentGenerationStore {
    pub fn open(
        root: impl AsRef<Path>,
        limits: GenerationStoreLimits,
    ) -> Result<Self, GenerationStoreError> {
        if limits.max_generations == 0
            || limits.max_generations > MAX_PERSISTED_GENERATIONS
            || limits.max_bytes == 0
            || limits.max_bytes > MAX_PERSISTED_BYTES
        {
            return Err(GenerationStoreError::InvalidLimits);
        }
        let root = root.as_ref().to_path_buf();
        if fs::symlink_metadata(&root).is_err() {
            let mut builder = DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&root) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(GenerationStoreError::Io(error)),
            }
        }
        let metadata = fs::symlink_metadata(&root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GenerationStoreError::InvalidRoot);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(GenerationStoreError::InvalidRoot);
            }
        }

        let mut store = Self {
            root,
            limits,
            entries: BTreeMap::new(),
            bytes: 0,
        };
        let mut scanned = 0;
        let mut scanned_pack_bytes = 0usize;
        for item in fs::read_dir(&store.root)? {
            scanned += 1;
            if scanned > MAX_SCANNED_FILES {
                return Err(GenerationStoreError::ScanLimit {
                    limit: MAX_SCANNED_FILES,
                });
            }
            let item = item?;
            let metadata = fs::symlink_metadata(item.path())?;
            let path = item.path();
            if !metadata.file_type().is_symlink()
                && metadata.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map_or(false, is_temporary_pack_name)
            {
                fs::remove_file(path)?;
                continue;
            }
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || path
                    .extension()
                    .map_or(true, |extension| extension != "hzip")
            {
                continue;
            }
            let Some(expected) = digest_from_filename(&path) else {
                continue;
            };
            let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
            if size > DEFAULT_MAX_PACK_BYTES || size > limits.max_bytes {
                let _ = fs::remove_file(&path);
                continue;
            }
            scanned_pack_bytes = scanned_pack_bytes.saturating_add(size);
            if scanned_pack_bytes > MAX_SCANNED_PACK_BYTES {
                return Err(GenerationStoreError::ScanByteLimit {
                    limit_bytes: MAX_SCANNED_PACK_BYTES,
                });
            }
            match read_generation(&path, size) {
                Ok(generation) if generation.digest() == expected => {
                    store.bytes = store.bytes.saturating_add(size);
                    store.entries.insert(
                        expected,
                        Entry {
                            path,
                            bytes: size,
                            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        },
                    );
                }
                Ok(_)
                | Err(GenerationStoreError::InvalidPack(_))
                | Err(GenerationStoreError::InvalidRoot) => {
                    let _ = fs::remove_file(path);
                }
                Err(GenerationStoreError::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        while store.entries.len() > store.limits.max_generations
            || store.bytes > store.limits.max_bytes
        {
            store.evict_oldest()?;
        }
        Ok(store)
    }

    /// Store a validated immutable generation atomically and return its identity.
    pub fn store(&mut self, generation: &BaseGeneration) -> Result<Digest, GenerationStoreError> {
        let pack = GenerationPack::from_generation(generation)
            .map_err(GenerationStoreError::InvalidPack)?;
        let size = pack.len();
        if size > self.limits.max_bytes {
            return Err(GenerationStoreError::EntryExceedsBudget {
                entry_bytes: size,
                budget_bytes: self.limits.max_bytes,
            });
        }
        let digest = generation.digest();
        if let Some(existing) = self.load(digest)? {
            if existing.digest() == digest {
                return Ok(digest);
            }
        }
        while self.entries.len() >= self.limits.max_generations
            || self.bytes.saturating_add(size) > self.limits.max_bytes
        {
            self.evict_oldest()?;
        }

        let final_path = self.root.join(filename(digest));
        let temp_path = self.root.join(format!(
            ".pack-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed),
        ));
        let write_result = (|| -> Result<(), std::io::Error> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp_path)?;
            file.write_all(pack.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp_path, &final_path)?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp_path);
            return Err(GenerationStoreError::Io(error));
        }
        let modified = fs::metadata(&final_path)?
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH);
        self.entries.insert(
            digest,
            Entry {
                path: final_path,
                bytes: size,
                modified,
            },
        );
        self.bytes = self.bytes.saturating_add(size);
        Ok(digest)
    }

    /// Load a cached generation. Corrupt or identity-mismatched cache data is
    /// evicted and returned as a miss so the trusted owner can rebuild from source.
    pub fn load(&mut self, digest: Digest) -> Result<Option<BaseGeneration>, GenerationStoreError> {
        let Some(entry) = self.entries.get(&digest).cloned() else {
            return Ok(None);
        };
        match read_generation(&entry.path, entry.bytes) {
            Ok(generation) if generation.digest() == digest => {
                if let Ok(file) = File::open(&entry.path) {
                    let _ = file.set_modified(SystemTime::now());
                }
                if let Some(current) = self.entries.get_mut(&digest) {
                    current.modified = SystemTime::now();
                }
                Ok(Some(generation))
            }
            Ok(_)
            | Err(GenerationStoreError::InvalidPack(_))
            | Err(GenerationStoreError::InvalidRoot) => {
                self.remove_entry(digest)?;
                Ok(None)
            }
            Err(GenerationStoreError::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                self.remove_entry(digest)?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub fn stats(&self) -> GenerationStoreStats {
        GenerationStoreStats {
            generations: self.entries.len(),
            bytes: self.bytes,
        }
    }

    fn evict_oldest(&mut self) -> Result<(), GenerationStoreError> {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(digest, entry)| (entry.modified, **digest))
            .map(|(digest, _)| *digest);
        if let Some(digest) = oldest {
            self.remove_entry(digest)?;
        }
        Ok(())
    }

    fn remove_entry(&mut self, digest: Digest) -> Result<(), GenerationStoreError> {
        if let Some(entry) = self.entries.get(&digest).cloned() {
            match fs::remove_file(entry.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(GenerationStoreError::Io(error)),
            }
            self.entries.remove(&digest);
            self.bytes = self.bytes.saturating_sub(entry.bytes);
        }
        Ok(())
    }
}

fn read_generation(
    path: &Path,
    expected_size: usize,
) -> Result<BaseGeneration, GenerationStoreError> {
    if expected_size > DEFAULT_MAX_PACK_BYTES {
        return Err(GenerationStoreError::InvalidPack(
            IndexError::PackTooLarge {
                limit: DEFAULT_MAX_PACK_BYTES,
            },
        ));
    }
    let linked = fs::symlink_metadata(path)?;
    if linked.file_type().is_symlink() || !linked.is_file() {
        return Err(GenerationStoreError::InvalidRoot);
    }
    let file = File::open(path)?;
    let metadata_size = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    if metadata_size != expected_size || metadata_size > DEFAULT_MAX_PACK_BYTES {
        return Err(GenerationStoreError::InvalidPack(
            IndexError::InvalidPackEncoding,
        ));
    }
    let mut bytes = Vec::with_capacity(metadata_size);
    file.take((DEFAULT_MAX_PACK_BYTES as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() != metadata_size {
        return Err(GenerationStoreError::InvalidPack(
            IndexError::InvalidPackEncoding,
        ));
    }
    GenerationPack::decode(&bytes).map_err(GenerationStoreError::InvalidPack)
}

fn filename(digest: Digest) -> String {
    let mut name = String::with_capacity(5 + 64);
    name.push_str("gen-");
    for byte in digest.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".hzip");
    name
}

fn is_temporary_pack_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(".pack-")
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((process, sequence)) = rest.split_once('-') else {
        return false;
    };
    !process.is_empty()
        && !sequence.is_empty()
        && process.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

fn digest_from_filename(path: &Path) -> Option<Digest> {
    let name = path.file_name()?.to_str()?;
    let hex = name.strip_prefix("gen-")?.strip_suffix(".hzip")?;
    let hex = hex.as_bytes();
    if hex.len() != 64 {
        return None;
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        let high = decode_hex(hex[index * 2])?;
        let low = decode_hex(hex[index * 2 + 1])?;
        *byte = (high << 4) | low;
    }
    Some(Digest::from_bytes(digest))
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}
