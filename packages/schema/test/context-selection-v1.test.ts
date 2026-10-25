import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { ContextSelectionV1 } from "../src/context-selection-v1"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const sources = [
  {
    kind: "agent-profile" as const,
    sourceID: "horizon.default",
    sourceRevision: "3",
    contentDigest: digest("a"),
    sourceAuthority: "core-config" as const,
    trust: "system" as const,
    included: true as const,
    inclusionReason: "profile" as const,
  },
  {
    kind: "provider-input" as const,
    sourceID: "req_context_1",
    sourceRevision: "12",
    contentDigest: digest("b"),
    sourceAuthority: "core-prompt-compiler" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "current_request" as const,
  },
]

test("ContextSelectionV1 requires explicit direct lane, active profile and exact provider input", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const input = {
    schemaVersion: 1,
    lane: "direct" as const,
    sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
    requestID: "req_context_1",
    mode: "fresh" as const,
    sourceRevision: "12",
    sources,
  }
  const decoded = decode(input)
  expect(decoded).toEqual(input as unknown as typeof decoded)
  expect(() => decode({ ...input, lane: undefined })).toThrow()
  expect(() => decode({ ...input, sourceRevision: "18446744073709551616" })).toThrow()
  expect(() => decode({ ...input, sessionID: "session-without-prefix" })).toThrow()
  expect(() => decode({ ...input, sources: [sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [sources[0], sources[0], sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [{ ...sources[0], sourceAuthority: "session-store" }, sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [{ ...sources[0], contentDigest: `sha256:${"c".repeat(64)}` }, sources[1]] })).toThrow()
  expect(() => decode({ ...input, untrustedSelectionDigest: digest("c") })).toThrow()
})

/**
 * Strict-decode parity additions against the canonical
 * `arch_V1/contracts-v2/context-selection-v1.schema.json`:
 * - session-message / agent-profile `sourceRevision` must be a canonical
 *   DecimalU64 (`$defs/source` -> `then` clause, `$defs/revision` bounds);
 * - direct lane must never pin managed-task/accepted-spec sources (allOf[0]);
 * - only the `toolset:` manifest carries `harnessRevision` (allOf[5] else).
 */
test("ContextSelectionV1 enforces canonical DecimalU64 revisions on pinned source kinds", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const messageSource = {
    kind: "session-message" as const,
    sourceID: "msg_01J9ABCDEF0123456789ABCDEFGH",
    sourceRevision: "12",
    contentDigest: digest("f"),
    sourceAuthority: "session-store" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "history" as const,
  }
  const input = {
    schemaVersion: 1 as const,
    lane: "direct" as const,
    sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
    requestID: "req_context_1",
    mode: "conversation_slice" as const,
    sourceRevision: "12",
    sources: [messageSource, sources[0], sources[1]],
  }
  const decoded = decode(input)
  expect(decoded).toEqual(input as unknown as typeof decoded)
  // session-message revisions are DecimalU64 cursors, not arbitrary opaque IDs.
  expect(() =>
    decode({ ...input, sources: [{ ...messageSource, sourceRevision: "cursor_v2" }, sources[0], sources[1]] }),
  ).toThrow()
  expect(() =>
    decode({ ...input, sources: [{ ...messageSource, sourceRevision: "0012" }, sources[0], sources[1]] }),
  ).toThrow()
  // agent-profile revision is a bounded u64 decimal (<= 18446744073709551615).
  expect(() =>
    decode({
      ...input,
      sources: [messageSource, { ...sources[0], sourceRevision: "9".repeat(25) }, sources[1]],
    }),
  ).toThrow()
  expect(() =>
    decode({
      ...input,
      sources: [messageSource, { ...sources[0], sourceRevision: "18446744073709551616" }, sources[1]],
    }),
  ).toThrow()
})

test("ContextSelectionV1 rejects managed-lane sources on a direct selection", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const messageSource = {
    kind: "session-message" as const,
    sourceID: "msg_01J9ABCDEF0123456789ABCDEFGH",
    sourceRevision: "12",
    contentDigest: digest("f"),
    sourceAuthority: "session-store" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "history" as const,
  }
  const managedTask = {
    kind: "managed-task" as const,
    sourceID: "task_01J9ABCDEF0123456789ABCDEFGH",
    sourceRevision: "7",
    contentDigest: digest("9"),
    sourceAuthority: "managed-control" as const,
    trust: "workspace" as const,
    included: true as const,
    inclusionReason: "required" as const,
  }
  expect(() =>
    decode({
      schemaVersion: 1,
      lane: "direct",
      sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
      requestID: "req_context_1",
      mode: "conversation_slice",
      sourceRevision: "12",
      sources: [messageSource, sources[0], sources[1], managedTask],
    }),
  ).toThrow()
})

test("ContextSelectionV1 pins harnessRevision only on the toolset manifest", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const generation = digest("7")
  const messageSource = {
    kind: "session-message" as const,
    sourceID: "msg_01J9ABCDEF0123456789ABCDEFGH",
    sourceRevision: "12",
    contentDigest: digest("f"),
    sourceAuthority: "session-store" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "history" as const,
  }
  const manifest = {
    kind: "tool" as const,
    sourceID: "toolset:horizon.native",
    sourceRevision: generation,
    contentDigest: generation,
    sourceAuthority: "tool-registry" as const,
    trust: "system" as const,
    included: true as const,
    inclusionReason: "selected_tool" as const,
    harnessRevision: 4,
  }
  const member = {
    kind: "tool" as const,
    sourceID: "read",
    sourceRevision: generation,
    contentDigest: digest("8"),
    sourceAuthority: "tool-registry" as const,
    trust: "system" as const,
    included: true as const,
    inclusionReason: "selected_tool" as const,
  }
  const input = {
    schemaVersion: 1 as const,
    lane: "direct" as const,
    sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
    requestID: "req_context_1",
    mode: "conversation_slice" as const,
    sourceRevision: "12",
    sources: [messageSource, sources[0], sources[1], manifest, member],
  }
  const decoded = decode(input)
  expect(decoded).toEqual(input as unknown as typeof decoded)
  // Non-manifest sources must not carry a harness revision (canonical else.not).
  expect(() =>
    decode({ ...input, sources: [messageSource, sources[0], sources[1], manifest, { ...member, harnessRevision: 4 }] }),
  ).toThrow()
  expect(() =>
    decode({ ...input, sources: [messageSource, sources[0], sources[1], { ...manifest, harnessRevision: undefined }, member] }),
  ).toThrow()
})

/*
 * CTX-006 — cross-runtime `harnessRevision` parity (arch_V1/32 §32.45).
 *
 * One fixed managed `ContextSelectionV1` fixture (a toolset manifest
 * `toolset:horizon.native` carrying `harnessRevision`) is validated against:
 * 1. the canonical `arch_V1/contracts-v2/context-selection-v1.schema.json`
 *    through a real Draft 2020-12 validator (`jsonschema`-python — the same
 *    path `scripts/architecture/validate_convergence.py` uses, with
 *    `horizon://` `$id` resolution, never a hand-rolled JSON check);
 * 2. this TS mirror under the strict decode typed consumers use
 *    (`onExcessProperty: "error"`) — the mirror is never more permissive.
 * The Rust `kernel/src/context_selection.rs` unit test asserts the identical
 * accept/reject matrix over the same fixture values.
 *
 * The toolset `sourceRevision`/`contentDigest` are the exact domain-separated
 * BLAKE3 digests the Rust decoder recomputes over
 * `horizon.toolset.v1\0` + compact JSON `{"harnessID":"horizon.native","harnessRevision":N,"members":[]}`,
 * so all three runtimes pin the same fixture bytes.
 */
const generation1 = "blake3:2e76c0a2b5575398bb1f0e70bbf5f9f952680e9f1320c45b9aebe87950dfcd41"
const generationMaxSafe = "blake3:3da61f55abff1515f9d596e7fc31fc7080060df9d71f5a86e9f993ec435d7ba8"

/** The shared CTX-006 fixture shape; `harnessRevision` is the matrix variable. */
const managedSelectionFixture = (harnessRevision: unknown, generation: string): Record<string, unknown> => ({
  schemaVersion: 1,
  lane: "managed",
  sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
  requestID: "ctxreq_01J9ABCDEF0123456789ABCDEFGH",
  attemptID: "attempt_01J9ABCDEF0123456789ABCDEFGH",
  requestSequence: "1",
  mode: "conversation_slice",
  sourceRevision: "12",
  sources: [
    {
      kind: "session-message",
      sourceID: "msg_01J9ABCDEF0123456789ABCDEFGH",
      sourceRevision: "12",
      contentDigest: `sha256:${"a".repeat(64)}`,
      sourceAuthority: "session-store",
      trust: "user",
      included: true,
      inclusionReason: "history",
    },
    {
      kind: "provider-input",
      sourceID: "ctxreq_01J9ABCDEF0123456789ABCDEFGH",
      sourceRevision: "1",
      contentDigest: `blake3:${"b".repeat(64)}`,
      sourceAuthority: "core-prompt-compiler",
      trust: "mixed",
      included: true,
      inclusionReason: "current_request",
    },
    {
      kind: "managed-task",
      sourceID: "task_01J9ABCDEF0123456789ABCDEFGH",
      sourceRevision: "7",
      contentDigest: `blake3:${"9".repeat(64)}`,
      sourceAuthority: "managed-control",
      trust: "workspace",
      included: true,
      inclusionReason: "required",
    },
    {
      kind: "accepted-spec",
      sourceID: "spec_01J9ABCDEF0123456789ABCDEFGH",
      sourceRevision: "3",
      contentDigest: `blake3:${"6".repeat(64)}`,
      sourceAuthority: "managed-control",
      trust: "workspace",
      included: true,
      inclusionReason: "required",
    },
    {
      kind: "agent-profile",
      sourceID: "profile_default",
      sourceRevision: "1",
      contentDigest: `blake3:${"c".repeat(64)}`,
      sourceAuthority: "core-config",
      trust: "system",
      included: true,
      inclusionReason: "profile",
    },
    {
      kind: "tool",
      sourceID: "toolset:horizon.native",
      sourceRevision: generation,
      contentDigest: generation,
      sourceAuthority: "tool-registry",
      trust: "system",
      included: true,
      inclusionReason: "selected_tool",
      harnessRevision,
    },
  ],
})

const contractsPath = (name: string) => fileURLToPath(new URL(`../../../arch_V1/contracts-v2/${name}`, import.meta.url))

/**
 * Draft 2020-12 validation of the canonical artifacts via jsonschema-python.
 *
 * The `horizon://schemas/*` `$id`/`$ref` URIs are aliased in-memory to an
 * `https://` mirror because jsonschema-python's `urljoin` cannot fragment-join
 * over unknown URI schemes (`#/$defs/...` inside a `$ref`'d document would
 * resolve against the wrong root). Only the URI scheme is rewritten on the
 * in-memory copies — every constraint, bound and enum of the canonical
 * artifacts is validated exactly as published, and the on-disk canonical
 * files are never modified.
 */
const CANONICAL_VALIDATOR = `
import json, sys
from jsonschema import Draft202012Validator, RefResolver
PREFIX, MIRROR = "horizon://schemas/", "https://horizon-schemas.invalid/"
def remap(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str) and value.startswith(PREFIX):
                node[key] = MIRROR + value[len(PREFIX):]
            else:
                remap(value)
    elif isinstance(node, list):
        for value in node:
            remap(value)
store, roots = {}, {}
for path in sys.argv[1:5]:
    data = json.load(open(path))
    remap(data)
    store[data["$id"]] = data
    roots[path.rsplit("/", 1)[-1][: -len(".schema.json")]] = data
cases = json.loads(sys.argv[5])
out = {}
for name, case in cases.items():
    schema = roots[case["schema"]]
    validator = Draft202012Validator(schema, resolver=RefResolver.from_schema(schema, store=store))
    errors = list(validator.iter_errors(case["instance"]))
    out[name] = {"valid": not errors, "error": errors[0].message if errors else None}
print(json.dumps(out))
`

interface CanonicalResult {
  valid: boolean
  error: string | null
}

const canonicalValidate = (
  cases: Record<string, { schema: "context-selection-v1" | "context-ledger-v2"; instance: unknown }>,
): Record<string, CanonicalResult> => {
  const proc = Bun.spawnSync({
    cmd: [
      "python3",
      "-c",
      CANONICAL_VALIDATOR,
      contractsPath("context-selection-v1.schema.json"),
      contractsPath("context-ledger-v2.schema.json"),
      contractsPath("context-compile-policy-v1.schema.json"),
      contractsPath("wire-primitives-v1.schema.json"),
      JSON.stringify(cases),
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error(`canonical validator failed: ${proc.stderr.toString()}`)
  return JSON.parse(proc.stdout.toString()) as Record<string, CanonicalResult>
}

const HARNESS_REVISION_MATRIX: Array<{ name: string; revision: unknown; generation: string; valid: boolean }> = [
  { name: "accept_integer_1", revision: 1, generation: generation1, valid: true },
  { name: "accept_integer_max_safe", revision: 9007199254740991, generation: generationMaxSafe, valid: true },
  { name: "reject_decimal_string", revision: "1", generation: generation1, valid: false },
  { name: "reject_zero", revision: 0, generation: generation1, valid: false },
  { name: "reject_negative", revision: -1, generation: generation1, valid: false },
  { name: "reject_above_max_safe", revision: 9007199254740992, generation: generation1, valid: false },
]

test("CTX-006: canonical context-selection-v1 and the TS strict mirror agree on the harnessRevision matrix", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const cases: Record<string, { schema: "context-selection-v1"; instance: unknown }> = {}
  for (const row of HARNESS_REVISION_MATRIX) {
    const fixture = managedSelectionFixture(row.revision, row.generation)
    cases[row.name] = { schema: "context-selection-v1", instance: fixture }
    let tsValid = true
    try {
      decode(fixture)
    } catch {
      tsValid = false
    }
    expect(`ts:${row.name}=${tsValid}`).toBe(`ts:${row.name}=${row.valid}`)
  }
  // The accepted fixture survives the strict decode unchanged (integer identity).
  const accepted = managedSelectionFixture(1, generation1)
  expect(decode(accepted)).toEqual(accepted as unknown as ReturnType<typeof decode>)
  // Regression guard against over-correcting: `sourceRevision` stays a
  // DecimalU64 *string* in both the canonical artifact and the TS mirror.
  const numericRevision = { ...accepted, sourceRevision: 12 }
  cases.source_revision_integer = { schema: "context-selection-v1", instance: numericRevision }
  expect(() => decode(numericRevision)).toThrow()

  const canonical = canonicalValidate(cases)
  for (const row of HARNESS_REVISION_MATRIX) {
    expect(`canonical:${row.name}=${canonical[row.name]?.valid}`).toBe(`canonical:${row.name}=${row.valid}`)
  }
  expect(`canonical:source_revision_integer=${canonical.source_revision_integer?.valid}`).toBe(
    "canonical:source_revision_integer=false",
  )
  // Fail loud if `horizon://` $ref resolution silently failed and everything
  // validated (or errored) for the wrong reason.
  expect(canonical.accept_integer_1?.error ?? null).toBeNull()
  expect(canonical.reject_zero?.error ?? null).toContain("minimum")
})
