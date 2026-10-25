/** Authenticated Core → Rust document-read adapter for LSP synchronization.
 * This module has no filesystem fallback and no authority to apply edits. */

import { Effect, Schema } from "effect"
import { Location } from "@opencode-ai/schema"
import type { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import {
  SessionSupervisorError,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import {
  MAX_REPO_DOCUMENT_BYTES,
  RepoDocumentReadRequestV1,
  type RepoDocumentReadResponseV1,
} from "@opencode-ai/schema/repo-intelligence-v1"

export interface AuthenticatedRepoDocumentV1 {
  readonly text: string
  readonly contentDigest: RepoDocumentReadResponseV1["contentDigest"]
  readonly revisionKind: "workspace" | "discovery_observation"
  readonly observedWorkspaceRevision: RepoDocumentReadResponseV1["observedWorkspaceRevision"]
}

export interface LspRepoDocumentReadRequestV1 {
  readonly schemaVersion: 1
  readonly pathRef: string
  readonly expectedWorkspaceRevision: string
  readonly maxBytes: number
}

/** Plain-wire input accepted by the effect builder before the strict schema
 * decode. `expectedWorkspaceRevision` is a branded digest in the canonical
 * schema; the trusted reader validates it with the curried decoder instead of
 * asserting the brand. */
export type RepoDocumentReadInputV1 =
  Omit<typeof RepoDocumentReadRequestV1.Type, "schemaVersion" | "revisionKind" | "expectedWorkspaceRevision"> & {
    readonly expectedWorkspaceRevision: string
  }

const decodeRepoDocumentReadRequestV1 = Schema.decodeUnknownSync(RepoDocumentReadRequestV1, {
  onExcessProperty: "error",
})

/** The trusted runner accepts exactly the effects this adapter composes:
 * requirements beyond the trusted principal context can never be satisfied by
 * the trusted application runtime boundary, so the type refuses them instead of
 * laundering an arbitrary environment through `never`. */
type RunTrustedEffect = <A, E>(effect: Effect.Effect<A, E, TrustedPrincipalContext>) => Promise<A>

/** Build the Promise callback expected by the LSP client. The caller must run
 * this Effect in the trusted Core application runtime so the supervisor can
 * obtain `TrustedPrincipalContext`; no caller identity is accepted here. */
export const makeRepoDocumentReadEffect = (
  supervisor: Pick<SessionSupervisorInterface, "readRepoDocument">,
  identity: {
    readonly sessionID: string
    readonly locationRef: typeof Location.Ref.Type
  },
  request: RepoDocumentReadInputV1,
): Effect.Effect<AuthenticatedRepoDocumentV1, SessionSupervisorError, TrustedPrincipalContext> => {
  if (!supervisor.readRepoDocument) {
    return Effect.fail(new SessionSupervisorError({
      stage: "repo-document",
      reason: "authenticated HostKernel RepoIntel document reads are unavailable",
    }))
  }
  let validated: RepoDocumentReadRequestV1
  try {
    validated = decodeRepoDocumentReadRequestV1({ schemaVersion: 1, revisionKind: "workspace", ...request })
  } catch {
    return Effect.fail(new SessionSupervisorError({
      stage: "repo-document",
      reason: "document read request failed strict schema validation",
    }))
  }
  return supervisor.readRepoDocument({
    ...identity,
    request: validated,
  }).pipe(Effect.map((document) => ({
    text: document.text,
    contentDigest: document.contentDigest,
    revisionKind: document.revisionKind,
    observedWorkspaceRevision: document.observedWorkspaceRevision,
  })))
}

/** Adapts the Core Effect to the callback shape consumed by the LSP client.
 * The supplied runner must be the trusted application runtime (which provides
 * `TrustedPrincipalContext`), never a detached runtime with forged identity. */
export const makeRepoDocumentReader = (
  supervisor: Pick<SessionSupervisorInterface, "readRepoDocument">,
  identity: {
    readonly sessionID: string
    readonly locationRef: typeof Location.Ref.Type
  },
  runTrustedEffect: RunTrustedEffect,
): ((request: LspRepoDocumentReadRequestV1) => Promise<AuthenticatedRepoDocumentV1>) =>
  (request) => runTrustedEffect(makeRepoDocumentReadEffect(supervisor, identity, {
    pathRef: request.pathRef,
    expectedWorkspaceRevision: request.expectedWorkspaceRevision,
    maxBytes: Math.min(MAX_REPO_DOCUMENT_BYTES, Math.max(1, Math.trunc(request.maxBytes) || 1)),
  }))
