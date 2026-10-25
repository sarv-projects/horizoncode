"""Frozen BLAKE3 vectors for scripts/eval/blake3.py.

Provenance of this table (generated once, offline, inside this repository):

* 45 inputs (0-10,000 bytes, covering the 64-byte block boundaries, the
  1024-byte chunk boundaries at 1023/1024/1025, 2047/2048/2049, 3072, 4096,
  8192 and multi-chunk tree shapes, plus five fixed UTF-8 strings) were hashed
  by **two independent implementations already vendored in this repository**:
  `@noble/hashes/blake3` (the library `packages/core` uses for canonical
  `blake3:` digests) and `blake3-wasm@2.1.5` (bun.lock-pinned).
* The two references agreed byte-for-byte on all 45 inputs; those agreed
  digests are frozen below. Regeneration is a development-time check only: the
  test itself never shells out and never depends on a package still being
  installed.
* The empty-input digest below is the published BLAKE3 root hash
  `af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262`.

These vectors make the evaluator's `blake3:` digests verifiable without Cargo,
network access, or trust in this module's prose.
"""
import unittest

import blake3


def _pattern(length: int) -> bytes:
    """The deterministic byte pattern used to generate the length vectors."""
    return bytes((index * 7 + 11) % 256 for index in range(length))


VECTORS = {
    '0': 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    '1': 'caebfd3859f5380eff54715148444178be18edefa3d1ceae275982f1a2824a91',
    '2': '646b56d7a47df30877006ec12a667e686a8c09a65f5eb22e0169a9cbf7f52bdb',
    '3': '7d7004cfaa1de4132d56405614418d6d7d1399963cc29531d526aec5802110e8',
    '4': '327cd3641224951565910857b28b6b00b9ae74fc7073907ea06cb5b800a3ad85',
    '5': '40ba93eb557f0d252080e33a4665fb386be2ebb6db17fbffda891d6997259b43',
    '6': 'b68a1fcc5b74797c4a81cdb3e444cf5662df4c5518955c20da53ea6b527dd441',
    '7': 'b7fcc8b44b56a6dbb138c27eb5894111c4cabb27c1424b3ef09f1f8be28e8d12',
    '8': '004492943c8bccfbd84ec91cb49f31e2aee60e26144d28b356ac409ffc748bd4',
    '15': 'ac4a58022a11145346a078e248f330ce099c38c5d8d5b2a78c4b4a8f3823a7ff',
    '16': 'c8a3a5892d0d5731f7614d55f915c3eddafb123f648ff6002102e2cb3115397d',
    '17': 'f098fc03e571821343da449f12b782cf1288287a39baf174a80bdcd6edfe1f33',
    '31': '6868200230590ebccfa66a2ce16c162f2bcead0a3bd7e9becfc52f93c7f93619',
    '32': 'aa1af3673b41eafaeadde6e2d591311ae20eac075ab2088423602fc0af7f02d4',
    '33': 'f38e59a9754086c7dc4104e18c2167004be7ca73f707a146159c6832e2e1162a',
    '63': 'a68845644b95d76470220497ff5f56375470e1a97f3b45c16917d65969489a83',
    '64': '7b9d6f37ace65c5d54426ae97fb07d6636d83b5631d8dcd2a928033abe343422',
    '65': '1aa58c0b7b1381a71fa15ac3b0f5abba6afad0d316b327b3bcd0f67a05290726',
    '127': '9f9d34bda0cd8cd0b7f1ead172e4c690299b11e5895108fc3e3d1048895adfe8',
    '128': 'e40d5db220a074a32e55bcc457b8f92e2c864ce789c4bf00048c5de8166cd383',
    '129': 'b1f7c867c4f02cf93417ff79c8e68885d4993b8d893991f20bbdd42d6c0634d4',
    '255': 'c6d228d556728ee436e366fb4ca61576e638b71bc82e15ba90e159093fcf15ff',
    '256': '4db32446968753a3c957700b221d93abc2e40c3e41abe4b808aa575b5c257cae',
    '257': '5d7c1217d939015c26d8949b83da1c034441d1d27b6071167ebdca628fbb4e8a',
    '511': '2fab5fb734f24f0df194cc392b64f4fd4b6d72e6df78d05740ceb595b94b98c8',
    '512': '256910e67b700a53e16ec10e3f912a9d5522ac14a5ddb5d10c033d7b0f86f0fe',
    '513': 'a163166e09c13bdf014fe54ad677c5c4f091e793adfcb595287baf2df8a7ef42',
    '1023': '6e10aeae5916ba7f02828b86c83c2868b7fb81711226a4a21412669425b6c4f1',
    '1024': '3c58a877133ddefbccddfed1c3b44c0f9a9afe48d57ef1d7a86694eb328da840',
    '1025': '3e92708addefb89bdf8569b31159f3b0f28c2ba978c8c5b99327e2d243718376',
    '1088': '9b7dcaca5fc75bf02ee5a89088ebcdfa21b2fff147e3ddb60c02cc09bdcbe00b',
    '2047': '106f2e78631fc5b86ab4419eca301dbe9f35de65035295363a053c52b1130595',
    '2048': '0d4a1a09801bc667e0352a86b433e88932f707bbbf51122359b027fbc8ab690d',
    '2049': '127dc88c3c925f0b40210d9b2eca582365f19f77d7ca93390f90f2935911f5b1',
    '3072': 'a34af32d33ee9beab9455777f69aab9ea84fcd1a56e55068ac20ba3eaa92702b',
    '4096': '338bcecb9b940be26137655b745e60217e27b4e27a68a24f7570bef03d26e848',
    '4097': 'b7b75ac4a119bed81c60ae55d592fb51c89ead05dda0ce3555c53a571ddc5ca6',
    '5000': '6c17ddf9dbccfffbb29b7543a54d4c0cfb71cfd097706d59b4453e4b9a731672',
    '8192': 'e704cf63db92c1ea90ac80ba772d2e0ef1c033442a0111d32abef81bd900294b',
    '10000': 'fa8883a198c86fc9ba50294dee5e5c6fc7350979018e535c241f9660506914ec',
    'text:': 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    'text:a': '17762fddd969a453925d65717ac3eea21320b66b54342fde15128d6caf21215f',
    'text:abc': '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85',
    'text:hello world': 'd74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24',
    'text:blake3': 'aca4f0133c931ea1d8420a3a9b96d7a15ef245b1755224d80db917cee17c86c7',
}


class Blake3VectorTests(unittest.TestCase):
    def test_frozen_vectors_match(self):
        for key, expected in VECTORS.items():
            with self.subTest(key=key):
                if key.startswith("text:"):
                    data = key[len("text:"):].encode("utf-8")
                else:
                    data = _pattern(int(key))
                self.assertEqual(blake3.blake3(data).hex(), expected)

    def test_empty_input_is_the_published_root_hash(self):
        self.assertEqual(
            blake3.blake3(b"").hex(),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
        )

    def test_digest_helper_emits_the_canonical_prefixed_form(self):
        digest = blake3.blake3_digest("dispatch-key")
        self.assertRegex(digest, r"^blake3:[0-9a-f]{64}$")
        self.assertEqual(digest, "blake3:" + blake3.blake3(b"dispatch-key").hex())

    def test_unsupported_modes_and_non_bytes_input_are_refused(self):
        with self.assertRaises(TypeError):
            blake3.blake3("text-not-bytes")  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            blake3.blake3_digest(123)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            blake3.blake3([1, 2, 3])  # type: ignore[arg-type]
        # Keyed-hash / derive-key flags are not implemented: the compressor
        # refuses them rather than silently hashing under the wrong mode.
        with self.assertRaises(ValueError):
            blake3._compress(list(blake3._IV), [0] * 16, 0, 64, 16)

    def test_chunk_boundary_inputs_stay_stable(self):
        # One full chunk, one full chunk plus a byte, and two exact chunks:
        # these are the tree-shape boundaries most likely to regress.
        for length in (1024, 1025, 2048):
            with self.subTest(length=length):
                self.assertEqual(
                    blake3.blake3(_pattern(length)).hex(),
                    VECTORS[str(length)],
                )


if __name__ == "__main__":
    unittest.main()
