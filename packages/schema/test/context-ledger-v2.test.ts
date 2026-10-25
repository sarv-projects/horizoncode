import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { ContextLedgerV2 } from "../src/context-ledger-v2"
import { ContextCompilePolicyV1 } from "../src/context-compile-policy-v1"
import { SessionEvent } from "../src/session-event"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const sessionID = "ses_01J9ABCDEF0123456789ABCDEFGH"

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

const contextSelection = {
  schemaVersion: 1 as const,
  lane: "direct" as const,
  sessionID,
  requestID: "req_context_1",
  mode: "fresh" as const,
  sourceRevision: "12",
  sources,
}

const entries = [
  {
    entryID: "agent-profile:horizon.default",
    kind: "system" as const,
    sourceRef: "agent-profile:horizon.default",
    trust: "system" as const,
    bytes: 512,
    bytesKind: "exact" as const,
    tokens: { kind: "unknown" as const },
    included: true,
    inclusionReason: "profile",
    protected: true,
    cacheClass: "static" as const,
    digest: digest("d"),
  },
  {
    entryID: "provider-input:req_context_1",
    kind: "user" as const,
    sourceRef: "provider-input:req_context_1",
    trust: "mixed" as const,
    bytes: 128,
    bytesKind: "exact" as const,
    tokens: { kind: "exact" as const, value: 32, tokenizerID: "anthropic-2025-05-14" },
    included: true,
    inclusionReason: "current_request",
    protected: false,
    cacheClass: "turn" as const,
    digest: digest("e"),
  },
]

const ledgerBase = {
  schemaVersion: 2 as const,
  lane: "direct" as const,
  sessionID,
  requestID: "req_context_1",
  sourceRevision: "12",
  providerID: "anthropic",
  modelID: "claude-sonnet-4-20250514",
  harnessID: "horizon.default",
  harnessRevision: 1,
  requestPayloadDigest: digest("c"),
  requestBytes: 2048,
  contextSelection,
  entries,
  completeness: "complete" as const,
}

/**
 * Exactly the object `resolveContextCompilePolicyV1` returns after its strict
 * decode (`packages/core/src/session/context-compile-policy.ts`): an explicit
 * auto→cache_anchor resolution on an explicit-breakpoints route with the full
 * advisory catalog hint block and the pinned anchor artifact ref.
 */
const compilePolicy = {
  schemaVersion: 1 as const,
  requested: "auto" as const,
  effective: "cache_anchor" as const,
  resolvedFrom: "route_adapter" as const,
  prefixCacheSupport: "explicit_breakpoints" as const,
  catalogHints: {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
    catalogSource: "bundled" as const,
    catalogFreshness: "fresh" as const,
    contextLimitTokens: 200_000,
    outputLimitTokens: 8_192,
    priceCacheReadKnown: true,
    priceCacheWriteKnown: true,
  },
  anchorArtifactRef: "repo_anchor_artifact_1",
  anchorProjection: "full" as const,
}

// The canonical JSON schema is closed (`additionalProperties: false`), so the
// strict mirror decode used by typed consumers sets `onExcessProperty: error`.
const decode = (value: unknown) => Schema.decodeUnknownSync(ContextLedgerV2, { onExcessProperty: "error" })(value)

test("ContextLedgerV2 carries the §30.26 compilePolicy exactly as compileContextLedgerV2 produces it", () => {
  const input = { ...ledgerBase, compilePolicy }
  const decoded = decode(input)
  // The policy must survive the strict decode unchanged; a mirror without the
  // field silently strips it and fails this equality.
  expect(decoded).toEqual(input as unknown as typeof decoded)
  expect(decoded.compilePolicy).toEqual(compilePolicy)
  expect(ContextCompilePolicyV1).toBeDefined()
})

test("compilePolicy stays optional, matching the canonical required list", () => {
  const decoded = decode(ledgerBase)
  expect(decoded.compilePolicy).toBeUndefined()
})

test("canonical additionalProperties:false parity inside compilePolicy", () => {
  // With the field present, a strict decode rejects unknown policy properties.
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, cacheTier: "aggressive" } })).toThrow()
})

test("compilePolicy enum and bound parity with context-compile-policy-v1", () => {
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, effective: "cache_aggressive" } })).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, resolvedFrom: "telemetry" } })).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, prefixCacheSupport: "sometimes" } })).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, anchorProjection: "partial" } })).toThrow()
  expect(() =>
    decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, catalogHints: { ...compilePolicy.catalogHints, providerID: undefined } } }),
  ).toThrow()
  expect(() =>
    decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, catalogHints: { ...compilePolicy.catalogHints, contextLimitTokens: 0 } } }),
  ).toThrow()
  expect(() =>
    decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, catalogHints: { ...compilePolicy.catalogHints, outputLimitTokens: 100_000_001 } } }),
  ).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, anchorArtifactRef: "a".repeat(513) } })).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy: { ...compilePolicy, schemaVersion: 2 } })).toThrow()
})

test("ledger identity cross-checks still hold when compilePolicy is present", () => {
  expect(() =>
    decode({ ...ledgerBase, compilePolicy, sourceRevision: "13" }),
  ).toThrow()
  expect(() => decode({ ...ledgerBase, compilePolicy, lane: "managed" })).toThrow()
})

/*
 * CTX-006 / CTX-007 — canonical↔mirror parity against the exact
 * `arch_V1/contracts-v2` artifacts (arch_V1/32 §32.45).
 *
 * A real Draft 2020-12 validator (`jsonschema`-python, the same path
 * `scripts/architecture/validate_convergence.py` uses, with `horizon://`
 * `$id` resolution) validates the canonical artifacts; the TS mirror runs
 * under the strict decode typed consumers use (`onExcessProperty: "error"`).
 * Every case asserts both runtimes agree on the identical input — the mirror
 * is never more permissive than the canonical.
 */

// --- shared CTX-006 fixture (same bytes as context-selection-v1.test.ts and the Rust decoder test) ---

const generation1 = "blake3:2e76c0a2b5575398bb1f0e70bbf5f9f952680e9f1320c45b9aebe87950dfcd41"
const generationMaxSafe = "blake3:3da61f55abff1515f9d596e7fc31fc7080060df9d71f5a86e9f993ec435d7ba8"
const selectionSessionID = "ses_01J9ABCDEF0123456789ABCDEFGH"
const selectionRequestID = "ctxreq_01J9ABCDEF0123456789ABCDEFGH"

const managedSelectionFixture = (harnessRevision: unknown, generation: string): Record<string, unknown> => ({
  schemaVersion: 1,
  lane: "managed",
  sessionID: selectionSessionID,
  requestID: selectionRequestID,
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
      sourceID: selectionRequestID,
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

const managedLedgerFixture = (
  selectionHarnessRevision: unknown,
  generation: string,
  ledgerHarnessRevision: unknown = 1,
): Record<string, unknown> => ({
  schemaVersion: 2,
  lane: "managed",
  sessionID: selectionSessionID,
  requestID: selectionRequestID,
  sourceRevision: "12",
  providerID: "anthropic",
  modelID: "claude-sonnet-4-20250514",
  harnessID: "horizon.native",
  harnessRevision: ledgerHarnessRevision,
  requestPayloadDigest: digest("c"),
  requestBytes: 2048,
  contextSelection: managedSelectionFixture(selectionHarnessRevision, generation),
  contextSelectionDigest: digest("d"),
  entries: [],
  completeness: "complete",
})

// --- canonical validator (shared shape with context-selection-v1.test.ts) ---

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

/** Runs the identical input through the canonical artifact and the TS strict mirror. */
const expectParity = (
  cases: Record<string, { schema: "context-selection-v1" | "context-ledger-v2"; instance: unknown }>,
  expected: Record<string, boolean>,
): Record<string, CanonicalResult> => {
  const canonical = canonicalValidate(cases)
  for (const [name, want] of Object.entries(expected)) {
    let tsValid = true
    try {
      decode(cases[name]!.instance)
    } catch {
      tsValid = false
    }
    expect(`ts:${name}=${tsValid}`).toBe(`ts:${name}=${want}`)
    expect(`canonical:${name}=${canonical[name]?.valid}`).toBe(`canonical:${name}=${want}`)
  }
  return canonical
}

// These parity rows shell out to `python3` + `jsonschema` (the same canonical
// validator `validate_convergence.py` uses). A cold interpreter can exceed the
// 5s bun default while other test files run in parallel, which failed the row
// as a timeout rather than a contract disagreement. The assertions are
// unchanged; only the external-validator budget is declared explicitly.
test("CTX-006: canonical context-ledger-v2 and the TS strict mirror agree on the harnessRevision matrix", () => {
  const matrix: Array<{ name: string; revision: unknown; generation: string; valid: boolean }> = [
    { name: "accept_integer_1", revision: 1, generation: generation1, valid: true },
    { name: "accept_integer_max_safe", revision: 9007199254740991, generation: generationMaxSafe, valid: true },
    { name: "reject_decimal_string", revision: "1", generation: generation1, valid: false },
    { name: "reject_zero", revision: 0, generation: generation1, valid: false },
    { name: "reject_negative", revision: -1, generation: generation1, valid: false },
    { name: "reject_above_max_safe", revision: 9007199254740992, generation: generation1, valid: false },
  ]
  // Position 1: the harnessRevision inside the embedded ContextSelectionV1
  // toolset manifest (ledger top-level harnessRevision stays valid).
  const selectionCases: Record<string, { schema: "context-ledger-v2"; instance: unknown }> = {}
  const selectionExpected: Record<string, boolean> = {}
  for (const row of matrix) {
    selectionCases[row.name] = { schema: "context-ledger-v2", instance: managedLedgerFixture(row.revision, row.generation) }
    selectionExpected[row.name] = row.valid
  }
  const selectionCanonical = expectParity(selectionCases, selectionExpected)
  expect(selectionCanonical.reject_zero?.error ?? null).toContain("minimum")
  expect(selectionCanonical.reject_above_max_safe?.error ?? null).toContain("maximum")
  expect(selectionCanonical.reject_decimal_string?.error ?? null).toContain("1")
  // Position 2: the ledger's own top-level harnessRevision.
  const ledgerCases: Record<string, { schema: "context-ledger-v2"; instance: unknown }> = {}
  const ledgerExpected: Record<string, boolean> = {}
  for (const row of matrix) {
    ledgerCases[row.name] = { schema: "context-ledger-v2", instance: managedLedgerFixture(1, generation1, row.revision) }
    ledgerExpected[row.name] = row.valid
  }
  expectParity(ledgerCases, ledgerExpected)
  // Regression guard against over-correcting: sourceRevision stays a
  // DecimalU64 string in both the canonical artifact and the TS mirror.
  const numericRevision = { ...managedLedgerFixture(1, generation1), sourceRevision: 12 }
  expectParity(
    { source_revision_integer: { schema: "context-ledger-v2", instance: numericRevision } },
    { source_revision_integer: false },
  )
  // The accepted fixture survives the strict decode unchanged.
  const accepted = managedLedgerFixture(1, generation1)
  expect(decode(accepted)).toEqual(accepted as unknown as ReturnType<typeof decode>)
}, 30_000)

test("CTX-007: canonical context-ledger-v2 and the TS strict mirror reject the identical bound violations", () => {
  const reasonBase = { ...ledgerBase, entries: [{ ...entries[0]!, inclusionReason: "r".repeat(256) }] }
  const policyWith = (patch: {
    catalogHints?: Record<string, unknown>
    anchorArtifactRef?: string
  }) => ({
    ...compilePolicy,
    catalogHints: { ...compilePolicy.catalogHints, ...patch.catalogHints },
    ...(patch.anchorArtifactRef === undefined ? {} : { anchorArtifactRef: patch.anchorArtifactRef }),
  })
  const cases: Record<string, { schema: "context-ledger-v2"; instance: unknown }> = {
    // included entries require a non-empty, ≤256-char reason
    inclusion_reason_empty: { schema: "context-ledger-v2", instance: { ...ledgerBase, entries: [{ ...entries[0]!, inclusionReason: "" }] } },
    inclusion_reason_257_chars: { schema: "context-ledger-v2", instance: { ...ledgerBase, entries: [{ ...entries[0]!, inclusionReason: "r".repeat(257) }] } },
    inclusion_reason_256_chars: { schema: "context-ledger-v2", instance: reasonBase },
    // catalogHints identifiers are 1..512
    catalog_provider_id_513: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { providerID: "p".repeat(513) } }) } },
    catalog_model_id_513: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { modelID: "m".repeat(513) } }) } },
    anchor_artifact_ref_513: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ anchorArtifactRef: "a".repeat(513) }) } },
    // catalog token limits are integers in 1..100000000
    context_limit_tokens_0: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { contextLimitTokens: 0 } }) } },
    context_limit_tokens_100000001: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { contextLimitTokens: 100_000_001 } }) } },
    output_limit_tokens_0: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { outputLimitTokens: 0 } }) } },
    output_limit_tokens_100000001: { schema: "context-ledger-v2", instance: { ...ledgerBase, compilePolicy: policyWith({ catalogHints: { outputLimitTokens: 100_000_001 } }) } },
    // exact boundaries stay accepted — the mirror never over-tightens
    boundary_values_accepted: {
      schema: "context-ledger-v2" as const,
      instance: {
        ...ledgerBase,
        entries: [{ ...entries[0]!, inclusionReason: "r".repeat(256) }],
        compilePolicy: policyWith({
          catalogHints: { providerID: "p".repeat(512), modelID: "m".repeat(512), contextLimitTokens: 1, outputLimitTokens: 100_000_000 },
          anchorArtifactRef: "a".repeat(512),
        }),
      },
    },
  }
  const expected: Record<string, boolean> = {
    inclusion_reason_empty: false,
    inclusion_reason_257_chars: false,
    inclusion_reason_256_chars: true,
    catalog_provider_id_513: false,
    catalog_model_id_513: false,
    anchor_artifact_ref_513: false,
    context_limit_tokens_0: false,
    context_limit_tokens_100000001: false,
    output_limit_tokens_0: false,
    output_limit_tokens_100000001: false,
    boundary_values_accepted: true,
  }
  const canonical = expectParity(cases, expected)
  // Sanity: the canonical rejections come from the expected bounds, not from
  // an unrelated schema/validator failure.
  expect(canonical.inclusion_reason_empty?.error ?? null).toContain("too short")
  expect(canonical.inclusion_reason_257_chars?.error ?? null).toContain("too long")
  expect(canonical.context_limit_tokens_0?.error ?? null).toContain("minimum")
  expect(canonical.boundary_values_accepted?.error ?? null).toBeNull()
}, 30_000)

/**
 * CTX-002 / CTX-003 / CTX-004 — evidence classes, exclusion provenance, pin
 * binding and the closed request-bound event (arch_V1/32 §32.45).
 */

test("CTX-002: exact, estimated and unknown byte/token evidence each keep their own class", () => {
  const exact = {
    ...entries[0]!,
    bytesKind: "exact" as const,
    bytes: 512,
    tokens: { kind: "exact" as const, value: 32, tokenizerID: "anthropic-2025-05-14" },
  }
  const estimated = { ...entries[0]!, bytesKind: "estimated" as const, bytes: 400, tokens: { kind: "estimated" as const, value: 30 } }
  const unknown = {
    entryID: entries[0]!.entryID,
    kind: entries[0]!.kind,
    sourceRef: entries[0]!.sourceRef,
    trust: entries[0]!.trust,
    bytesKind: "unknown" as const,
    tokens: { kind: "unknown" as const },
    included: true,
    inclusionReason: entries[0]!.inclusionReason!,
    protected: true,
    digest: entries[0]!.digest,
  }

  expect(decode({ ...ledgerBase, entries: [exact] }).entries[0]).toMatchObject({
    bytesKind: "exact",
    bytes: 512,
    tokens: { kind: "exact", value: 32, tokenizerID: "anthropic-2025-05-14" },
  })
  expect(decode({ ...ledgerBase, entries: [estimated] }).entries[0]).toMatchObject({
    bytesKind: "estimated",
    bytes: 400,
    tokens: { kind: "estimated", value: 30 },
  })

  // Unknown evidence stays *absent* — never rendered as zero, never fabricated.
  const unknownDecoded = decode({ ...ledgerBase, entries: [unknown] }).entries[0]!
  expect(unknownDecoded.bytes).toBeUndefined()
  expect(unknownDecoded.tokens.value).toBeUndefined()
  expect(unknownDecoded.tokens.tokenizerID).toBeUndefined()

  // ...and it cannot be smuggled into an unknown class as a number.
  expect(() => decode({ ...ledgerBase, entries: [{ ...unknown, bytes: 0 }] })).toThrow()
  expect(() => decode({ ...ledgerBase, entries: [{ ...unknown, tokens: { kind: "unknown" as const, value: 0 } }] })).toThrow()
  // Exact token evidence must name its tokenizer.
  expect(() => decode({ ...ledgerBase, entries: [{ ...exact, tokens: { kind: "exact" as const, value: 32 } }] })).toThrow()
  // Estimated byte evidence still requires a value.
  const estimatedWithoutBytes = {
    entryID: entries[0]!.entryID,
    kind: entries[0]!.kind,
    sourceRef: entries[0]!.sourceRef,
    trust: entries[0]!.trust,
    bytesKind: "estimated" as const,
    tokens: { kind: "estimated" as const, value: 30 },
    included: true,
    inclusionReason: entries[0]!.inclusionReason!,
    protected: false,
    digest: entries[0]!.digest,
  }
  expect(() => decode({ ...ledgerBase, entries: [estimatedWithoutBytes] })).toThrow()
})

test("CTX-003: excluded entries keep reason/protection/cache state and unpinned inclusion is rejected", () => {
  const excluded = {
    ...entries[0]!,
    entryID: "instruction:vendor-agents",
    sourceRef: "instruction:vendor-agents",
    included: false,
    inclusionReason: "excluded by the vendor glob",
    protected: true,
    cacheClass: "none" as const,
    freshness: "not_loaded",
  }
  const decoded = decode({ ...ledgerBase, entries: [...entries, excluded] })
  expect(decoded.entries.find((entry) => entry.entryID === "instruction:vendor-agents")).toMatchObject({
    included: false,
    inclusionReason: "excluded by the vendor glob",
    protected: true,
    cacheClass: "none",
    freshness: "not_loaded",
  })
  // Included entries keep their trust/protection/cache metadata unchanged.
  expect(decoded.entries.filter((entry) => entry.included)).toHaveLength(2)
  expect(decoded.entries.filter((entry) => entry.included).map((entry) => entry.protected)).toEqual([true, false])

  // An *included* entry must map to a pinned ContextSelection source.
  const unpinned = { ...entries[0]!, entryID: "artifact:rogue", sourceRef: "artifact:rogue" }
  expect(() => decode({ ...ledgerBase, entries: [...entries, unpinned] })).toThrow()

  // An included entry without an inclusion reason is rejected.
  const missingReason = {
    entryID: entries[0]!.entryID,
    kind: entries[0]!.kind,
    sourceRef: entries[0]!.sourceRef,
    trust: entries[0]!.trust,
    bytes: entries[0]!.bytes,
    bytesKind: entries[0]!.bytesKind,
    tokens: entries[0]!.tokens,
    included: true,
    protected: true,
    digest: entries[0]!.digest,
  }
  expect(() => decode({ ...ledgerBase, entries: [missingReason, entries[1]!] })).toThrow()
})

test("CTX-004: session.context_ledger is a closed, request-fenced projection with no raw prompt", () => {
  const payload = {
    id: "evt_01J9ABCDEF0123456789ABCDEFGH",
    type: "session.context_ledger" as const,
    data: {
      timestamp: 1_700_000_000_000,
      sessionID,
      requestID: "req_context_1",
      sourceRevision: "12",
      sourceGeneration: "gen_context_1",
      ledger: ledgerBase,
      ledgerDigest: digest("f"),
    },
  }
  const decodeEvent = Schema.decodeUnknownSync(SessionEvent.ContextLedger, { onExcessProperty: "error" })
  const decoded = decodeEvent(payload)
  expect(decoded).toMatchObject({
    type: "session.context_ledger",
    data: { sessionID, requestID: "req_context_1", sourceRevision: "12", sourceGeneration: "gen_context_1" },
  })

  // Fence: the ledger's request/revision identity must equal the pinned
  // ContextSelection carried inside it — a re-fenced ledger is rejected even
  // though every other field still decodes.
  expect(() =>
    decodeEvent({ ...payload, data: { ...payload.data, ledger: { ...ledgerBase, requestID: "req_context_2" } } }),
  ).toThrow()
  expect(() =>
    decodeEvent({ ...payload, data: { ...payload.data, ledger: { ...ledgerBase, sourceRevision: "13" } } }),
  ).toThrow()

  // Closed shape: no raw prompt, provider params, credentials or a duplicate
  // transcript record can ride along on the event.
  for (const forbidden of ["prompt", "messages", "params", "providerParams", "apiKey", "credentials", "text"]) {
    expect(() => decodeEvent({ ...payload, data: { ...payload.data, [forbidden]: "raw value" } })).toThrow()
  }
  const ledgerKeys = Object.keys(payload.data.ledger)
  expect(ledgerKeys).not.toContain("prompt")
  expect(ledgerKeys).not.toContain("messages")
  expect(JSON.stringify(payload.data.ledger)).not.toContain("raw prompt")
})
