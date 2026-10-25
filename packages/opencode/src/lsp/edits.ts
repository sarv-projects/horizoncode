import { Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AuthorityBinding, Ledger, Ref } from "./broker"

/**
 * Bounded LSP code-action/rename output contract. The LSP server is an
 * untrusted suggestion source: every document must carry an exact version,
 * and the host must later apply the edits through `files.patch` with the same
 * Guard lease and workspace revision. This module validates only; it never
 * writes files or turns an LSP result into authority.
 */
export const MAX_EDIT_DOCUMENTS = 256
export const MAX_EDITS_PER_DOCUMENT = 2_000
export const MAX_EDIT_BATCH_EDITS = 20_000
export const MAX_EDIT_BATCH_BYTES = 2 * 1024 * 1024

const Position = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const Range = Schema.Struct({ start: Position, end: Position })

export const TextEdit = Schema.Struct({ range: Range, newText: Schema.String })
export type TextEdit = typeof TextEdit.Type

/** A bounded, versioned `TextDocumentEdit` exactly as LSP emits it. Keeping
 * the standard nested shape avoids inventing a second proposal dialect; the
 * canonical `files.patch` bridge flattens it below. */
export const VersionedDocumentEdits = Schema.Struct({
  textDocument: Schema.Struct({
    uri: Schema.String,
    /** LSP textDocument.version; null/unversioned edits are deliberately refused. */
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  edits: Schema.Array(TextEdit),
})
export type VersionedDocumentEdits = typeof VersionedDocumentEdits.Type

/** Flattened batch document used by the Guarded files.patch intermediary. */
export type GuardedDocumentEdits = Readonly<{
  uri: string
  version: number
  edits: readonly TextEdit[]
}>

/** Only versioned, text-only WorkspaceEdit documents survive projection. */
export type VersionedWorkspaceEditV1 = Readonly<{
  documentChanges: readonly VersionedDocumentEdits[]
}>

export const GuardedEditBatch = Schema.Struct({
  serviceGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  workspaceRevision: Schema.String,
  effectIntentDigest: Schema.String,
  capabilityLeaseDigest: Schema.String,
  documents: Schema.Array(Schema.Struct({
    uri: Schema.String,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    edits: Schema.Array(TextEdit),
  })),
})
export type GuardedEditBatch = typeof GuardedEditBatch.Type

export type EditFailureReason =
  | "malformed"
  | "stale_service"
  | "stale_workspace"
  | "lease_mismatch"
  | "lease_already_consumed"
  | "unsupported_source"
  | "outside_workspace"
  | "unversioned"
  | "duplicate_document"
  | "overlapping_edits"
  | "too_many_documents"
  | "too_many_edits"
  | "too_many_bytes"
  | "too_complex"
  | "unsupported_workspace_operation"

export class EditValidationError extends Schema.TaggedErrorClass<EditValidationError>()("LspEditValidationError", {
  reason: Schema.Literals([
    "malformed",
    "stale_service",
    "stale_workspace",
    "lease_mismatch",
    "lease_already_consumed",
    "unsupported_source",
    "outside_workspace",
    "unversioned",
    "duplicate_document",
    "overlapping_edits",
    "too_many_documents",
    "too_many_edits",
    "too_many_bytes",
    "too_complex",
    "unsupported_workspace_operation",
  ]),
}) {}

const decodeBatch = Schema.decodeUnknownSync(GuardedEditBatch)
const encoder = new TextEncoder()

function fail(reason: EditFailureReason): never {
  throw new EditValidationError({ reason })
}

function filePath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== "file:") return
    return path.resolve(fileURLToPath(parsed))
  } catch {
    return
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function comparePosition(a: { line: number; character: number }, b: { line: number; character: number }): number {
  return a.line - b.line || a.character - b.character
}

function hasExactKeys(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return keys.every((key) => actual.includes(key)) && actual.every((key) => keys.includes(key) || optional.includes(key))
}

function isExactBatchShape(input: unknown): boolean {
  if (
    !hasExactKeys(input, [
      "serviceGeneration",
      "workspaceRevision",
      "effectIntentDigest",
      "capabilityLeaseDigest",
      "documents",
    ])
  ) {
    return false
  }
  if (!Array.isArray(input.documents) || input.documents.length > MAX_EDIT_DOCUMENTS) return false
  return input.documents.every((document) => {
    if (!hasExactKeys(document, ["uri", "version", "edits"])) return false
    if (!Array.isArray(document.edits) || document.edits.length > MAX_EDITS_PER_DOCUMENT) return false
    return document.edits.every((edit) => {
      if (!hasExactKeys(edit, ["range", "newText"]) || !hasExactKeys(edit.range, ["start", "end"])) return false
      return hasExactKeys(edit.range.start, ["line", "character"]) && hasExactKeys(edit.range.end, ["line", "character"])
    })
  })
}

/** Validate server output against the live service, revision, workspace and lease. */
export function validateGuardedEditBatch(
  input: unknown,
  expected: {
    readonly serviceGeneration: number
    readonly workspaceRevision: string
    readonly workspaceRoot: string
    readonly effectIntentDigest: string
    readonly capabilityLeaseDigest: string
  },
): GuardedEditBatch {
  if (
    !Number.isSafeInteger(expected.serviceGeneration) ||
    expected.serviceGeneration < 1 ||
    !/^blake3:[0-9a-f]{64}$/.test(expected.workspaceRevision)
  ) {
    return fail("malformed")
  }
  if (!path.isAbsolute(expected.workspaceRoot)) return fail("outside_workspace")
  if (
    typeof input === "object" &&
    input !== null &&
    "documents" in input &&
    Array.isArray(input.documents)
  ) {
    if (input.documents.length > MAX_EDIT_DOCUMENTS) return fail("too_many_documents")
    if (
      input.documents.some(
        (document) =>
          typeof document === "object" &&
          document !== null &&
          "edits" in document &&
          Array.isArray(document.edits) &&
          document.edits.length > MAX_EDITS_PER_DOCUMENT,
      )
    ) {
      return fail("too_many_edits")
    }
  }
  if (!isExactBatchShape(input)) {
    if (
      typeof input === "object" &&
      input !== null &&
      "documents" in input &&
      Array.isArray(input.documents) &&
      input.documents.some(
        (document) =>
          typeof document === "object" && document !== null && "version" in document && document.version === null,
      )
    ) {
      return fail("unversioned")
    }
    return fail("malformed")
  }
  let batch: GuardedEditBatch
  try {
    batch = decodeBatch(input)
  } catch {
    if (
      typeof input === "object" &&
      input !== null &&
      "documents" in input &&
      Array.isArray(input.documents) &&
      input.documents.some(
        (document) =>
          typeof document === "object" && document !== null && "version" in document && document.version === null,
      )
    ) {
      return fail("unversioned")
    }
    return fail("malformed")
  }
  if (batch.serviceGeneration !== expected.serviceGeneration) return fail("stale_service")
  if (
    !/^blake3:[0-9a-f]{64}$/.test(batch.workspaceRevision) ||
    batch.workspaceRevision !== expected.workspaceRevision
  ) return fail("stale_workspace")
  if (
    !/^blake3:[0-9a-f]{64}$/.test(expected.effectIntentDigest) ||
    batch.effectIntentDigest !== expected.effectIntentDigest
  ) {
    return fail("lease_mismatch")
  }
  if (
    !/^blake3:[0-9a-f]{64}$/.test(expected.capabilityLeaseDigest) ||
    batch.capabilityLeaseDigest !== expected.capabilityLeaseDigest
  ) {
    return fail("lease_mismatch")
  }
  if (batch.documents.length > MAX_EDIT_DOCUMENTS) return fail("too_many_documents")

  const root = path.resolve(expected.workspaceRoot)
  const seen = new Set<string>()
  let editCount = 0
  let bytes = 0
  for (const document of batch.documents) {
    const absolute = filePath(document.uri)
    if (!absolute || !isInside(root, absolute)) return fail("outside_workspace")
    if (seen.has(absolute)) return fail("duplicate_document")
    seen.add(absolute)
    editCount += document.edits.length
    if (editCount > MAX_EDIT_BATCH_EDITS) return fail("too_many_edits")
    if (document.edits.length > MAX_EDITS_PER_DOCUMENT) return fail("too_many_edits")
    const ordered = [...document.edits].sort((left, right) => {
      const start = comparePosition(left.range.start, right.range.start)
      return start || comparePosition(left.range.end, right.range.end)
    })
    let previous: TextEdit | undefined
    for (const edit of document.edits) {
      if (comparePosition(edit.range.start, edit.range.end) > 0) return fail("malformed")
      bytes += encoder.encode(edit.newText).byteLength + encoder.encode(document.uri).byteLength + 32
      if (bytes > MAX_EDIT_BATCH_BYTES) return fail("too_many_bytes")
    }
    for (const edit of ordered) {
      if (previous) {
        const overlap = comparePosition(previous.range.end, edit.range.start) > 0
        const ambiguousInsert =
          comparePosition(previous.range.start, previous.range.end) === 0 &&
          comparePosition(edit.range.start, edit.range.end) === 0 &&
          comparePosition(previous.range.start, edit.range.start) === 0
        if (overlap || ambiguousInsert) return fail("overlapping_edits")
      }
      previous = edit
    }
  }
  return Object.freeze({
    ...batch,
    documents: Object.freeze(
      batch.documents.map((document) =>
        Object.freeze({
          ...document,
          edits: Object.freeze(
            document.edits.map((edit) =>
              Object.freeze({
                ...edit,
                range: Object.freeze({
                  start: Object.freeze({ ...edit.range.start }),
                  end: Object.freeze({ ...edit.range.end }),
                }),
              }),
            ),
          ),
        }),
      ),
    ),
  })
}

/** Validate an LSP-produced workspace edit against the currently authenticated
 * broker generation. The host supplies Guard-issued intent/lease digests and
 * the authenticated workspace root; this helper never accepts a caller's
 * claimed generation or revision as authority. A later Rust `files.patch`
 * admission must still recheck the exact workspace revision and consume this
 * same one-use lease before any write.
 *
 * The returned batch reserves `(effectIntentDigest, capabilityLeaseDigest)`
 * for this ledger so the same Guard decision cannot be replayed as two
 * independent edit batches. Core-side reservation is defense in depth; Rust
 * remains the authority that actually consumes the one-use lease.
 */
export function validatePreparedEdits(
  input: unknown,
  authority: {
    readonly ledger: Ledger
    readonly ref: Ref
    readonly binding: AuthorityBinding
    readonly workspaceRoot: string
    readonly effectIntentDigest: string
    readonly capabilityLeaseDigest: string
  },
): GuardedEditBatch {
  const snapshot = authority.ledger.require(authority.ref, authority.binding)
  if (snapshot.source.kind === "external") return fail("unsupported_source")
  const documents = lspWorkspaceEditDocuments(input).map((document) => ({
    uri: document.textDocument.uri,
    version: document.textDocument.version,
    edits: document.edits,
  }))
  // Add the Guard metadata from the trusted host. LSP output is untrusted and
  // cannot author an effect intent or one-use lease.
  const prepared = validateGuardedEditBatch({
    serviceGeneration: snapshot.generation,
    workspaceRevision: snapshot.workspaceRevision,
    effectIntentDigest: authority.effectIntentDigest,
    capabilityLeaseDigest: authority.capabilityLeaseDigest,
    documents,
  }, {
    serviceGeneration: snapshot.generation,
    workspaceRevision: snapshot.workspaceRevision,
    workspaceRoot: authority.workspaceRoot,
    effectIntentDigest: authority.effectIntentDigest,
    capabilityLeaseDigest: authority.capabilityLeaseDigest,
  })
  reservePreparedLease(authority.ledger, prepared.effectIntentDigest, prepared.capabilityLeaseDigest)
  return prepared
}

const MAX_RESERVED_LEASES = 4096
const reservedPreparedLeases = new WeakMap<Ledger, Set<string>>()

function reservePreparedLease(ledger: Ledger, effectIntentDigest: string, capabilityLeaseDigest: string): void {
  let reserved = reservedPreparedLeases.get(ledger)
  if (!reserved) {
    reserved = new Set()
    reservedPreparedLeases.set(ledger, reserved)
  }
  const key = `${effectIntentDigest}\0${capabilityLeaseDigest}`
  if (reserved.has(key)) return fail("lease_already_consumed")
  // Bounded bookkeeping: the oldest reservation is forgotten rather than
  // growing without limit. Rust consumes the actual lease, so forgetting a
  // Core reservation cannot grant one.
  if (reserved.size >= MAX_RESERVED_LEASES) {
    const oldest = reserved.values().next().value
    if (oldest !== undefined) reserved.delete(oldest)
  }
  reserved.add(key)
}

const MAX_LSP_REQUEST_BYTES = 256 * 1024
const MAX_CODE_ACTIONS = 256

function boundedLspValue(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  budget.nodes += 1
  if (depth > 16 || budget.nodes > 4096) return fail("too_complex")
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (encoder.encode(value).byteLength > MAX_LSP_REQUEST_BYTES) return fail("too_many_bytes")
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("malformed")
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) boundedLspValue(item, depth + 1, budget)
    return
  }
  if (typeof value !== "object") return fail("malformed")
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
    return fail("malformed")
  }
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.includes("\0")) return fail("malformed")
    boundedLspValue(item, depth + 1, budget)
  }
}

function freezeLspJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeLspJson))
  if (typeof value !== "object" || value === null) return value
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeLspJson(child)])))
}

function validateLspPosition(value: unknown): value is { line: number; character: number } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    hasExactKeys(value, ["line", "character"]) &&
    Number.isSafeInteger(value.line) && Number(value.line) >= 0 &&
    Number.isSafeInteger(value.character) && Number(value.character) >= 0
}

function validateTextDocumentIdentifier(value: unknown): value is { uri: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !hasExactKeys(value, ["uri"])) return false
  if (typeof value.uri !== "string" || value.uri.length > 8 * 1024) return false
  try {
    return new URL(value.uri).protocol === "file:"
  } catch {
    return false
  }
}

/** Validate bounded `textDocument/codeAction` params before any host dispatch.
 * The HostKernel permits this read/query method only under
 * `language.diagnostics`; returned edits remain proposals. */
export function validateCodeActionParamsV1(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
    !hasExactKeys(input, ["textDocument", "range", "context"])) return fail("malformed")
  const record = input as Record<string, unknown>
  if (!validateTextDocumentIdentifier(record.textDocument) || typeof record.range !== "object" ||
    record.range === null || Array.isArray(record.range) || !hasExactKeys(record.range, ["start", "end"])) return fail("malformed")
  const range = record.range as Record<string, unknown>
  if (!validateLspPosition(range.start) || !validateLspPosition(range.end) ||
    comparePosition(range.start, range.end) > 0 || typeof record.context !== "object" ||
    record.context === null || Array.isArray(record.context) ||
    !hasExactKeys(record.context, ["diagnostics"], ["only", "triggerKind"])) return fail("malformed")
  const context = record.context as Record<string, unknown>
  if (!Array.isArray(context.diagnostics) ||
    (context.only !== undefined && (!Array.isArray(context.only) || context.only.some((kind) => typeof kind !== "string"))) ||
    (context.triggerKind !== undefined && context.triggerKind !== 1 && context.triggerKind !== 2)) return fail("malformed")
  boundedLspValue(input)
  if (encoder.encode(JSON.stringify(input)).byteLength > MAX_LSP_REQUEST_BYTES) return fail("too_many_bytes")
  return freezeLspJson(input) as Readonly<Record<string, unknown>>
}

/** Validate bounded `textDocument/rename` params. Returned edits remain
 * proposals and must pass `validatePreparedEdits` and the canonical
 * files.patch Guard path before any workspace mutation. */
export function validateRenameParamsV1(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
    !hasExactKeys(input, ["textDocument", "position", "newName"])) return fail("malformed")
  const record = input as Record<string, unknown>
  if (!validateTextDocumentIdentifier(record.textDocument) || !validateLspPosition(record.position) ||
    typeof record.newName !== "string" || !record.newName.trim() || encoder.encode(record.newName).byteLength > 4 * 1024) {
    return fail("malformed")
  }
  boundedLspValue(input)
  if (encoder.encode(JSON.stringify(input)).byteLength > MAX_LSP_REQUEST_BYTES) return fail("too_many_bytes")
  return freezeLspJson(input) as Readonly<Record<string, unknown>>
}

export type CodeActionEditProposalV1 = Readonly<{
  title: string
  kind?: string
  isPreferred?: boolean
  edit: VersionedWorkspaceEditV1
}>

/** Code-action responses with commands or arbitrary extension data are not
 * executed. Keep the human-facing title with each bounded edit proposal. */
export function validateCodeActionProposalsV1(input: unknown): readonly CodeActionEditProposalV1[] {
  if (input === null) return Object.freeze([])
  if (!Array.isArray(input) || input.length > MAX_CODE_ACTIONS) return fail("malformed")
  boundedLspValue(input)
  if (encoder.encode(JSON.stringify(input)).byteLength > MAX_EDIT_BATCH_BYTES) return fail("too_many_bytes")
  const proposals: CodeActionEditProposalV1[] = []
  for (const action of input) {
    if (typeof action !== "object" || action === null || Array.isArray(action) ||
      !hasExactKeys(action, ["title", "edit"], ["kind", "isPreferred", "diagnostics", "data"])) return fail("unsupported_workspace_operation")
    const value = action as Record<string, unknown>
    if (typeof value.title !== "string" || !value.title.trim() || encoder.encode(value.title).byteLength > 4096 ||
      (value.kind !== undefined && typeof value.kind !== "string") ||
      (value.isPreferred !== undefined && typeof value.isPreferred !== "boolean") ||
      (value.diagnostics !== undefined && !Array.isArray(value.diagnostics))) return fail("malformed")
    const documentChanges = lspWorkspaceEditDocuments(value.edit)
    proposals.push(Object.freeze({
      title: value.title,
      ...(value.kind === undefined ? {} : { kind: value.kind as string }),
      ...(value.isPreferred === undefined ? {} : { isPreferred: value.isPreferred as boolean }),
      edit: freezeLspJson({ documentChanges }) as VersionedWorkspaceEditV1,
    }))
  }
  return Object.freeze(proposals)
}

/** Rename returns a WorkspaceEdit or null. Null is a valid no-op; any
 * non-null payload is still untrusted and must pass `validatePreparedEdits`. */
export function validateRenameEditV1(input: unknown): VersionedWorkspaceEditV1 | undefined {
  if (input === null) return undefined
  boundedLspValue(input)
  if (encoder.encode(JSON.stringify(input)).byteLength > MAX_EDIT_BATCH_BYTES) return fail("too_many_bytes")
  const documentChanges = lspWorkspaceEditDocuments(input)
  return freezeLspJson({ documentChanges }) as VersionedWorkspaceEditV1
}

/**
 * Convert standard LSP WorkspaceEdit output into bounded, versioned docs.
 * `changes` has no document version, and resource operations can rename,
 * create, or delete files; both are refused. Only `documentChanges` with an
 * exact TextDocumentEdit shape can proceed to the canonical files.patch path.
 */
function lspWorkspaceEditDocuments(input: unknown): VersionedDocumentEdits[] {
  if (hasExactKeys(input, ["changes"])) return fail("unversioned")
  if (!hasExactKeys(input, ["documentChanges"])) {
    if (hasExactKeys(input, ["changes", "documentChanges"])) return fail("unsupported_workspace_operation")
    return fail("malformed")
  }
  const changes = input.documentChanges
  if (!Array.isArray(changes)) return fail("malformed")
  if (changes.length > MAX_EDIT_DOCUMENTS) return fail("too_many_documents")
  const documents: VersionedDocumentEdits[] = []
  let editCount = 0
  let textUnits = 0
  for (const change of changes) {
    if (!hasExactKeys(change, ["textDocument", "edits"])) return fail("unsupported_workspace_operation")
    const textDocument = change.textDocument
    if (!hasExactKeys(textDocument, ["uri", "version"])) return fail("unversioned")
    if (textDocument.version === null) return fail("unversioned")
    if (
      typeof textDocument.uri !== "string" ||
      typeof textDocument.version !== "number" ||
      !Number.isSafeInteger(textDocument.version) ||
      textDocument.version < 0
    ) {
      return fail("malformed")
    }
    if (textDocument.uri.length > MAX_EDIT_BATCH_BYTES) return fail("too_many_bytes")
    if (!Array.isArray(change.edits)) return fail("malformed")
    if (change.edits.length > MAX_EDITS_PER_DOCUMENT) return fail("too_many_edits")
    const edits: TextEdit[] = []
    for (const edit of change.edits) {
      // AnnotatedTextEdit and extension-bearing edits are refused instead of
      // silently discarding annotation or command semantics.
      if (!hasExactKeys(edit, ["range", "newText"]) || !hasExactKeys(edit.range, ["start", "end"])) {
        return fail("unsupported_workspace_operation")
      }
      if (!hasExactKeys(edit.range.start, ["line", "character"]) || !hasExactKeys(edit.range.end, ["line", "character"])) {
        return fail("malformed")
      }
      if (typeof edit.newText !== "string") return fail("malformed")
      editCount += 1
      textUnits += edit.newText.length + textDocument.uri.length + 32
      if (editCount > MAX_EDIT_BATCH_EDITS) return fail("too_many_edits")
      if (textUnits > MAX_EDIT_BATCH_BYTES) return fail("too_many_bytes")
      edits.push(edit as TextEdit)
    }
    documents.push({
      textDocument: { uri: textDocument.uri, version: textDocument.version as number },
      edits,
    })
  }
  return documents
}

export * as LspEdits from "./edits"
