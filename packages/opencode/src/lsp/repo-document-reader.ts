/** Authenticated Core → Rust document-read adapter for LSP synchronization.
 * This module has no filesystem fallback and no authority to apply edits. */

import { Effect } from "effect"
import { Location } from "@opencode-ai/schema"
import type { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import {
  SessionSupervisorError,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import { MAX_REPO_DOCUMENT_BYTES, type RepoDocumentReadRequestV1 } from "@opencode-ai/schema/repo-intelligence-v1"

export interface AuthenticatedRepoDocumentV1 {
  readonly text: string
  readonly contentDigest: string
  readonly revisionKind: "workspace" | "discovery_observation"
  readonly observedWorkspaceRevision: string
}

export interface LspRepoDocumentReadRequestV1 {
  readonly schemaVersion: 1
  readonly pathRef: string
  readonly expectedWorkspaceRevision: string
  readonly maxBytes: number
}

type RunTrustedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

/** Build the Promise callback expected by the LSP client. The caller must run
 * this Effect in the trusted Core application runtime so the supervisor can
 * obtain `TrustedPrincipalContext`; no caller identity is accepted here. */
export const makeRepoDocumentReadEffect = (
  supervisor: Pick<SessionSupervisorInterface, "readRepoDocument">,
  identity: {
    readonly sessionID: string
    readonly locationRef: typeof Location.Ref.Type
  },
  request: Omit<typeof RepoDocumentReadRequestV1.Type, "schemaVersion" | "revisionKind">,
): Effect.Effect<AuthenticatedRepoDocumentV1, SessionSupervisorError, TrustedPrincipalContext> => {
  if (!supervisor.readRepoDocument) {
    return Effect.fail(new SessionSupervisorError({
      stage: "repo-document",
      reason: "authenticated HostKernel RepoIntel document reads are unavailable",
    }))
  }
  return supervisor.readRepoDocument({
    ...identity,
    request: { schemaVersion: 1, revisionKind: "workspace", ...request },
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
