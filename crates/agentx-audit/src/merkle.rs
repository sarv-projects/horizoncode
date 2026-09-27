//! Segment Merkle roots over committed entry hashes.
//!
//! The construction is fixed so verification is reproducible without any
//! external reference:
//!
//! - a leaf is `LEAF_TAG || entry_hash_bytes`;
//! - an internal node is `NODE_TAG || left || right`;
//! - a level with an odd node count promotes the last node unchanged;
//! - an empty segment has the root of the empty tree.
//!
//! Promotion (rather than duplicating the last leaf) keeps the root a function
//! of the ordered leaf list alone, so any addition, removal, or reorder inside a
//! sealed segment changes the root.

use blake3::Hasher;

/// Domain-separation tag for a leaf node.
const LEAF_TAG: &[u8] = b"agentx/audit/merkle/leaf/v1";
/// Domain-separation tag for an internal node.
const NODE_TAG: &[u8] = b"agentx/audit/merkle/node/v1";

/// The Merkle root over an empty leaf set: the tagged hash of no children.
#[must_use]
pub fn empty_root() -> String {
    node(LEAF_TAG, &[0u8; 32], &[0u8; 32]).to_hex().to_string()
}

/// Computes the Merkle root over an ordered list of hex entry hashes.
///
/// # Panics
/// Panics if a leaf is not 32 bytes of hex; callers read leaves from this
/// crate's own hash functions or validate the length first.
#[must_use]
pub fn merkle_root(leaves: &[String]) -> String {
    if leaves.is_empty() {
        return empty_root();
    }
    let mut level: Vec<blake3::Hash> = leaves.iter().map(|leaf| decode32(leaf)).collect();
    while level.len() > 1 {
        let mut next: Vec<blake3::Hash> = Vec::with_capacity(level.len().div_ceil(2));
        let (pairs, remainder) = level.as_chunks::<2>();
        for duo in pairs {
            next.push(node(NODE_TAG, duo[0].as_bytes(), duo[1].as_bytes()));
        }
        if let Some(last) = remainder.first() {
            // Promote the trailing odd node unchanged.
            next.push(*last);
        }
        level = next;
    }
    level[0].to_hex().to_string()
}

/// A `blake3` hash of two 32-byte children with a domain tag.
fn node(tag: &[u8], left: &[u8; 32], right: &[u8; 32]) -> blake3::Hash {
    let mut hasher = Hasher::new();
    hasher.update(tag);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize()
}

/// The `blake3` keyed hash of `data` under `key`, as hex.
#[must_use]
pub fn keyed_digest(key: &[u8; 32], data: &[u8]) -> String {
    blake3::keyed_hash(key, data).to_hex().to_string()
}

/// The plain `blake3` hash of `data`, as hex.
#[must_use]
pub fn digest(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

/// Decodes a 64-character hex hash into 32 bytes.
fn decode32(hex: &str) -> blake3::Hash {
    let bytes = hex.as_bytes();
    assert_eq!(bytes.len(), 64, "merkle leaf must be a 32-byte hex hash");
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        let hi = (bytes[index * 2] as char).to_digit(16).expect("hex digit");
        let lo = (bytes[index * 2 + 1] as char)
            .to_digit(16)
            .expect("hex digit");
        *slot = ((hi << 4) | lo) as u8;
    }
    blake3::Hash::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(seed: &str) -> String {
        digest(seed.as_bytes())
    }

    #[test]
    fn root_is_deterministic_for_a_fixed_leaf_order() {
        let leaves = vec![leaf("a"), leaf("b"), leaf("c")];
        assert_eq!(merkle_root(&leaves), merkle_root(&leaves));
    }

    #[test]
    fn root_changes_when_a_leaf_changes() {
        let base = vec![leaf("a"), leaf("b"), leaf("c")];
        let mut tampered = base.clone();
        tampered[1] = leaf("b2");
        assert_ne!(merkle_root(&base), merkle_root(&tampered));
    }

    #[test]
    fn root_changes_when_leaves_are_reordered() {
        let base = vec![leaf("a"), leaf("b"), leaf("c"), leaf("d")];
        let mut reordered = base.clone();
        reordered.swap(1, 2);
        assert_ne!(merkle_root(&base), merkle_root(&reordered));
    }

    #[test]
    fn root_changes_when_a_leaf_is_added_or_removed() {
        let base = vec![leaf("a"), leaf("b"), leaf("c")];
        let mut added = base.clone();
        added.push(leaf("d"));
        let mut removed = base.clone();
        removed.remove(1);
        assert_ne!(merkle_root(&base), merkle_root(&added));
        assert_ne!(merkle_root(&base), merkle_root(&removed));
    }

    #[test]
    fn single_leaf_and_empty_roots_are_well_defined() {
        assert_ne!(merkle_root(&[]), merkle_root(&[leaf("a")]));
        assert_eq!(merkle_root(&[]), empty_root());
    }

    #[test]
    fn keyed_digest_depends_on_the_key() {
        let key_a = [7u8; 32];
        let key_b = [8u8; 32];
        let data = b"root record";
        assert_ne!(keyed_digest(&key_a, data), keyed_digest(&key_b, data));
        assert_eq!(keyed_digest(&key_a, data), keyed_digest(&key_a, data));
    }
}
