use horizon_indexd_library::{
    BaseGeneration, FileSnapshot, GenerationPins, GenerationStoreLimits, OpaquePin,
    PersistentGenerationStore,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "horizon-indexd-store-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create scratch directory");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("restrict scratch directory");
        }
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pin(value: &str) -> OpaquePin {
    OpaquePin::new(value.as_bytes().to_vec()).unwrap()
}

fn generation(revision: &str, contents: &str) -> BaseGeneration {
    BaseGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin(revision),
            read_scope: pin("scope"),
            read_policy: pin("policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new(
            "src/main.rs",
            contents.as_bytes().to_vec(),
        )],
    )
    .unwrap()
}

#[test]
fn immutable_generation_survives_store_reopen_and_is_digest_checked() {
    let scratch = Scratch::new();
    let original = generation("rev-1", "needle\n");
    let id = original.digest();

    let mut store =
        PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default())
            .expect("open store");
    store.store(&original).expect("persist generation");
    drop(store);

    let mut reopened =
        PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default())
            .expect("reopen store");
    let restored = reopened
        .load(id)
        .expect("load result")
        .expect("generation present");
    assert_eq!(restored.digest(), id);
    assert_eq!(restored.search("needle", 10).unwrap().matches.len(), 1);
}

#[test]
fn corrupt_cached_generation_is_removed_and_reported_as_a_rebuild_miss() {
    let scratch = Scratch::new();
    let original = generation("rev-2", "needle\n");
    let id = original.digest();
    let mut store =
        PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default()).unwrap();
    store.store(&original).unwrap();
    let file = fs::read_dir(scratch.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "hzip")
        })
        .expect("one cached pack");
    fs::write(&file, b"corrupt cache bytes").unwrap();

    assert!(store
        .load(id)
        .expect("corrupt cache is not fatal")
        .is_none());
    assert!(
        !file.exists(),
        "corrupt derived data must be evicted for rebuild"
    );
}

#[test]
fn entry_limit_evicts_oldest_rebuildable_generation() {
    let scratch = Scratch::new();
    let limits = GenerationStoreLimits {
        max_generations: 1,
        max_bytes: 2_000_000,
    };
    let first = generation("rev-1", "first\n");
    let second = generation("rev-2", "second\n");
    let mut store = PersistentGenerationStore::open(scratch.path(), limits).unwrap();
    store.store(&first).unwrap();
    store.store(&second).unwrap();

    assert!(store.load(first.digest()).unwrap().is_none());
    assert_eq!(
        store.load(second.digest()).unwrap().unwrap().digest(),
        second.digest()
    );
    assert_eq!(store.stats().generations, 1);
}

#[test]
fn read_policy_pin_changes_never_reuse_another_scope_generation() {
    let scratch = Scratch::new();
    let first = generation("rev-1", "same bytes\n");
    let other_scope = BaseGeneration::build(
        GenerationPins {
            repository: pin("repo"),
            workspace: Some(pin("workspace")),
            revision_set: pin("rev-1"),
            read_scope: pin("scope"),
            read_policy: pin("different-policy"),
            source_receipt: pin("receipt"),
            parser_set: pin("lexical-v1"),
        },
        [FileSnapshot::new("src/main.rs", b"same bytes\n".to_vec())],
    )
    .unwrap();
    assert_ne!(first.digest(), other_scope.digest());

    let mut store =
        PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default()).unwrap();
    store.store(&first).unwrap();
    store.store(&other_scope).unwrap();
    assert_eq!(store.stats().generations, 2);
    assert_eq!(
        store.load(first.digest()).unwrap().unwrap().digest(),
        first.digest()
    );
    assert_eq!(
        store.load(other_scope.digest()).unwrap().unwrap().digest(),
        other_scope.digest()
    );
}

#[test]
fn one_pack_larger_than_store_budget_is_rejected_without_partial_file() {
    let scratch = Scratch::new();
    let generation = generation("rev-3", "content\n");
    let mut store = PersistentGenerationStore::open(
        scratch.path(),
        GenerationStoreLimits {
            max_generations: 1,
            max_bytes: 1,
        },
    )
    .expect("small positive cache is valid");

    assert!(store.store(&generation).is_err());
    assert_eq!(store.stats().generations, 0);
    assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn cache_refuses_a_root_accessible_to_other_users() {
    use std::os::unix::fs::PermissionsExt;

    let scratch = Scratch::new();
    fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default()),
        Err(horizon_indexd_library::GenerationStoreError::InvalidRoot)
    ));
}

#[test]
fn reopen_discards_incomplete_temporary_packs_after_owner_restart() {
    let scratch = Scratch::new();
    let interrupted = scratch.path().join(".pack-98765-42.tmp");
    fs::write(&interrupted, b"partial pack").unwrap();

    let _store = PersistentGenerationStore::open(scratch.path(), GenerationStoreLimits::default())
        .expect("cache restart should recover from an incomplete atomic write");
    assert!(!interrupted.exists());
}
