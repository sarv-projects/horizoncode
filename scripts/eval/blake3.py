"""Pure-Python BLAKE3-256 (unkeyed hash mode, 32-byte output).

Why this module exists
----------------------
The HostKernel HostRun routes (`managed.v1/host_run.bind`,
`managed.v1/host_run.bind_receipt`, `managed.v1/host_run.inspect`) require
`dispatchKeyDigest` and `manifestDigest` to be canonical `blake3:<64 hex>`
digests, and the Python standard library ships no BLAKE3. The evaluator must
therefore compute a real BLAKE3 over its dispatch idempotency key: emitting a
sha256 value under a `blake3:` label, or hand-shaped hex, would be fabricated
provenance.

Scope and honesty
-----------------
* Unkeyed hash mode only. Keyed-hash and derive-key modes are rejected, not
  guessed.
* 32-byte output only; one-shot API (`blake3`, `blake3_digest`).
* Correctness does not rest on this file's prose: `scripts/eval/test_blake3.py`
  pins a frozen vector set that was generated locally from **two independent
  implementations already vendored in this repository** — `@noble/hashes/blake3`
  (the library `packages/core` uses for every canonical `blake3:` digest) and
  `blake3-wasm` — after verifying the two agree byte-for-byte. Matching those
  vectors means the evaluator's digests match the kernel/TS digest convention.
* This is a *digest* helper for evaluator identity derivation. It is not a
  signature scheme, a MAC, or an authorization primitive: no trust decision may
  rest on possession of a BLAKE3 value alone.
"""
from __future__ import annotations

# SHA-256 / BLAKE2 / BLAKE3 initial value.
_IV = (
    0x6A09E667,
    0xBB67AE85,
    0x3C6EF372,
    0xA54FF53A,
    0x510E527F,
    0x9B05688C,
    0x1F83D9AB,
    0x5BE0CD19,
)

# Message-word permutation applied between rounds (BLAKE3 schedule).
_MSG_PERMUTATION = (2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8)

CHUNK_START = 1
CHUNK_END = 2
PARENT = 4
ROOT = 8

_BLOCK_LEN = 64
_CHUNK_LEN = 1024
_MASK32 = 0xFFFFFFFF

# Every flag this module may set. KEYED_HASH / DERIVE_KEY_CONTEXT /
# DERIVE_KEY_MATERIAL are deliberately not accepted: those modes are not
# implemented here.
_ALLOWED_FLAGS = CHUNK_START | CHUNK_END | PARENT | ROOT


def _rotr(value: int, bits: int) -> int:
    return ((value >> bits) | (value << (32 - bits))) & _MASK32


def _g(state, a, b, c, d, mx, my):
    state[a] = (state[a] + state[b] + mx) & _MASK32
    state[d] = _rotr(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & _MASK32
    state[b] = _rotr(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b] + my) & _MASK32
    state[d] = _rotr(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & _MASK32
    state[b] = _rotr(state[b] ^ state[c], 7)


def _round(state, message):
    _g(state, 0, 4, 8, 12, message[0], message[1])
    _g(state, 1, 5, 9, 13, message[2], message[3])
    _g(state, 2, 6, 10, 14, message[4], message[5])
    _g(state, 3, 7, 11, 15, message[6], message[7])
    _g(state, 0, 5, 10, 15, message[8], message[9])
    _g(state, 1, 6, 11, 12, message[10], message[11])
    _g(state, 2, 7, 8, 13, message[12], message[13])
    _g(state, 3, 4, 9, 14, message[14], message[15])


def _words(block: bytes) -> list[int]:
    padded = block + b"\x00" * (_BLOCK_LEN - len(block))
    return [int.from_bytes(padded[index:index + 4], "little") for index in range(0, 64, 4)]


def _compress(chaining_value, message_words, counter, block_len, flags: int) -> list[int]:
    """BLAKE3 compression returning the 8-word chaining value / output words."""
    if flags & ~_ALLOWED_FLAGS:
        raise ValueError("unsupported BLAKE3 flags")
    state = list(chaining_value) + [
        _IV[0], _IV[1], _IV[2], _IV[3],
        counter & _MASK32,
        (counter >> 32) & _MASK32,
        block_len,
        flags,
    ]
    words = list(message_words)
    for _ in range(7):
        _round(state, words)
        words = [words[_MSG_PERMUTATION[index]] for index in range(16)]
    return [state[index] ^ state[index + 8] for index in range(8)]


def _blocks(data: bytes) -> list[bytes]:
    blocks = [data[index:index + _BLOCK_LEN] for index in range(0, len(data), _BLOCK_LEN)]
    return blocks if blocks else [b""]


def _chunk(data: bytes, chunk_index: int):
    """Return ``(chaining_value, root_output)`` for one 1024-byte chunk.

    The chaining value feeds the parent tree; the root output is the final
    block compressed with ``ROOT``, which is the whole digest when the input is
    a single chunk and intentionally differs from the chaining value.
    """
    blocks = _blocks(data)
    chaining_value = list(_IV)
    root_output = None
    for position, block in enumerate(blocks):
        flags = 0
        if position == 0:
            flags |= CHUNK_START
        if position == len(blocks) - 1:
            flags |= CHUNK_END
            root_output = _compress(
                chaining_value, _words(block), 0, len(block), flags | ROOT)
        chaining_value = _compress(
            chaining_value, _words(block), chunk_index, len(block), flags)
    if root_output is None:
        raise AssertionError("unreachable: a chunk always has a final block")
    return chaining_value, root_output


def _parent_words(left, right) -> list[int]:
    block = b"".join(word.to_bytes(4, "little") for word in left)
    block += b"".join(word.to_bytes(4, "little") for word in right)
    return _words(block)


def blake3(data: bytes) -> bytes:
    """Return the 32-byte BLAKE3 digest of ``data`` (unkeyed mode)."""
    if isinstance(data, str):
        raise TypeError("blake3() hashes bytes; encode text explicitly")
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("blake3() requires bytes-like input")
    data = bytes(data)
    chunks = [data[index:index + _CHUNK_LEN]
              for index in range(0, len(data), _CHUNK_LEN)] or [b""]

    # Canonical BLAKE3 tree via the reference stack algorithm: a new chunk is
    # merged with the stack top while the running chunk count is even, which
    # yields exactly the balanced tree BLAKE3 defines.
    stack: list[tuple] = []  # ("chunk", bytes, index) | ("parent", node, node)
    for index, chunk in enumerate(chunks):
        total = index + 1
        node = ("chunk", chunk, index)
        while total % 2 == 0:
            node = ("parent", stack.pop(), node)
            total //= 2
        stack.append(node)
    while len(stack) > 1:
        right = stack.pop()
        left = stack.pop()
        stack.append(("parent", left, right))

    memo: dict[int, list[int]] = {}

    def cv(node):
        if node[0] == "chunk":
            return _chunk(node[1], node[2])[0]
        key = id(node)
        if key not in memo:
            memo[key] = _compress(
                list(_IV), _parent_words(cv(node[1]), cv(node[2])),
                0, _BLOCK_LEN, PARENT)
        return memo[key]

    def root(node):
        if node[0] == "chunk":
            return _chunk(node[1], node[2])[1]
        return _compress(
            list(_IV), _parent_words(cv(node[1]), cv(node[2])),
            0, _BLOCK_LEN, PARENT | ROOT)

    return b"".join(word.to_bytes(4, "little") for word in root(stack[0]))


def blake3_digest(value: str) -> str:
    """Canonical ``blake3:<64 hex>`` digest of a text value."""
    if not isinstance(value, str):
        raise TypeError("blake3_digest() requires a string")
    return "blake3:" + blake3(value.encode("utf-8")).hex()
