import type { TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import type { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import type { SecureInputBinding, SecureInputOperation } from "./secure-input"

const MAX_REF_LENGTH = 256
const MAX_PRINCIPAL_SUBJECT_LENGTH = 200
const SAFE_REF = /^[^\s\u0000-\u001f\u007f]+$/

const boundedRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH && SAFE_REF.test(value)

const expectedVersion = (value: unknown): value is number | undefined =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)

/**
 * A validated HostKernel `secret.v1` write grant. The wire shape is decoded by
 * the production authorizer; Core only ever sees this exact projection.
 */
export interface CredentialMutationGrant extends SecureInputBinding {
  readonly grantRef: string
}

export interface CredentialMutationAuthorizer {
  /**
   * Returns a grant for the exact binding, or rejects/returns a mismatch. The
   * principal is always the trusted principal captured by
   * `TrustedPrincipalContext`; callers must never derive it from request input.
   */
  authorize(binding: SecureInputBinding, principal: TrustedPrincipal): Promise<CredentialMutationGrant>
}

/**
 * Trusted authenticated principal projection. `host_os` is the local process
 * owner; `server_auth` is the server-authenticated subject. Callers cannot
 * supply this value as request input.
 */
export function principalRefOf(principal: TrustedPrincipal): string | undefined {
  if (principal.kind === "host_os") return "host-os:local"
  if (!boundedRef(principal.subject) || principal.subject.length > MAX_PRINCIPAL_SUBJECT_LENGTH) return undefined
  return `server-auth:${principal.subject}`
}

export function mutationBinding(
  principal: TrustedPrincipal,
  input: {
    readonly providerId: string
    readonly operation: SecureInputOperation
    readonly idempotencyKey: string
    readonly expectedVersion?: number
    readonly secretRef?: string
  },
): SecureInputBinding | undefined {
  const principalRef = principalRefOf(principal)
  if (!principalRef) return undefined
  if (!boundedRef(input.providerId) || !boundedRef(input.idempotencyKey)) return undefined
  if (!expectedVersion(input.expectedVersion)) return undefined
  if (input.secretRef !== undefined && !boundedRef(input.secretRef)) return undefined
  if (input.operation !== "put" && input.operation !== "rotate" && input.operation !== "revoke") return undefined
  // A create binds no target; a rotation or revocation must name its exact
  // target ref and expected version, exactly as HostKernel requires.
  if (input.operation === "put") {
    if (input.secretRef !== undefined || input.expectedVersion !== undefined) return undefined
  } else if (input.secretRef === undefined || input.expectedVersion === undefined) {
    return undefined
  }
  return Object.freeze({
    principalRef,
    providerId: input.providerId,
    operation: input.operation,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    idempotencyKey: input.idempotencyKey,
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
  })
}

export function putBinding(
  input: Pick<SecretBrokerV1.PutRequestV1, "providerId" | "idempotencyKey" | "secretRef" | "expectedVersion">,
  principal: TrustedPrincipal,
): SecureInputBinding | undefined {
  if ((input.secretRef === undefined) !== (input.expectedVersion === undefined)) return undefined
  return mutationBinding(principal, {
    providerId: input.providerId,
    operation: input.secretRef === undefined ? "put" : "rotate",
    idempotencyKey: input.idempotencyKey,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
  })
}

/**
 * Strict runtime validation for an RPC grant. A grant is accepted only when it
 * carries exactly the expected binding fields (no extras) and a bounded opaque
 * grant reference. The target ref is part of the expected set exactly when the
 * binding has one, and a rotation/revocation without one is never grantable.
 * Any difference fails closed.
 */
export function exactMutationGrant(
  value: unknown,
  binding: SecureInputBinding,
): CredentialMutationGrant | undefined {
  if (
    (binding.operation === "rotate" || binding.operation === "revoke") &&
    binding.secretRef === undefined
  ) {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const grant = value as Record<string, unknown>
  const expectedKeys = [
    "grantRef",
    "principalRef",
    "providerId",
    "operation",
    ...(binding.expectedVersion === undefined ? [] : ["expectedVersion"]),
    "idempotencyKey",
    ...(binding.secretRef === undefined ? [] : ["secretRef"]),
  ]
  if (Object.keys(grant).length !== expectedKeys.length) return undefined
  if (expectedKeys.some((key) => !Object.hasOwn(grant, key))) return undefined
  if (!boundedRef(grant.grantRef)) return undefined
  if (grant.principalRef !== binding.principalRef) return undefined
  if (grant.providerId !== binding.providerId) return undefined
  if (grant.operation !== binding.operation) return undefined
  if (grant.idempotencyKey !== binding.idempotencyKey) return undefined
  if (binding.expectedVersion !== undefined && grant.expectedVersion !== binding.expectedVersion) return undefined
  if (binding.secretRef !== undefined && grant.secretRef !== binding.secretRef) return undefined
  return Object.freeze({
    grantRef: grant.grantRef,
    principalRef: binding.principalRef,
    providerId: binding.providerId,
    operation: binding.operation,
    ...(binding.expectedVersion === undefined ? {} : { expectedVersion: binding.expectedVersion }),
    idempotencyKey: binding.idempotencyKey,
    ...(binding.secretRef === undefined ? {} : { secretRef: binding.secretRef }),
  })
}

export * as SecretMutation from "./secret-mutation"
