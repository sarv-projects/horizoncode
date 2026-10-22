import { createHash } from "node:crypto"
import type { GlobalLaunchProfilesConfig } from "@/config/config"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import type { GuardApprovalRequest } from "@opencode-ai/core/session/supervisor"
import { validateExecutionLaunchProfileRef, type ExecutionLaunchProfileRefV1 } from "./process-scope"

/**
 * Core Config's immutable projection accepted by HostKernel's single
 * ExecutionHost resolver (§12.20, §37.6). This value contains no resolved
 * path, cwd, environment, PID, or OS handle. Callers must obtain it from the
 * trusted Core Config owner; workspace/project/plugin config is not a source.
 */
export type ExecutionLaunchProfileDefinitionV1 = {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly revision: string
  readonly kind: "lsp" | "dap" | "repl"
  readonly executableSelector: string
  readonly argv: readonly string[]
  readonly workingDirectoryPolicy: "registered_location_root"
  readonly environmentPolicy: "sanitized_host"
  /** DAP policy is retained in the immutable HostKernel definition; absent means disabled. */
  readonly dapPolicy?: { readonly allowEvaluate: boolean }
}

export type LaunchProfileResolutionScopeV1 = {
  readonly locationID: string
  readonly sessionID: string
  readonly userActionID: string
  readonly callID: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

export type LaunchProfileApprovalV1 = {
  readonly status: "needs_approval"
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "language.start" | "debug.start" | "repl.start"
  readonly locationID: string
  readonly sessionID: string
  readonly profileRef: ExecutionLaunchProfileRefV1
  /** Full host-generated consent projection; residual guarantees stay visible to the approver. */
  readonly approval: Omit<GuardApprovalRequest, "approvalID">
}

const MAX_SELECTOR_BYTES = 4096
const MAX_ARG_COUNT = 128
const MAX_ARG_BYTES = 4096
const MAX_TOTAL_ARG_BYTES = 64 * 1024
const MAX_U64 = 18_446_744_073_709_551_615n
const controlCharacters = /[\u0000-\u001f\u007f]/
const LEGACY_LSP_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  "typescript-language-server": "horizoncode:lsp:typescript-language-server",
  "rust-analyzer": "horizoncode:lsp:rust-analyzer",
  "pyright-langserver": "horizoncode:lsp:pyright-langserver",
  pylsp: "horizoncode:lsp:pylsp",
})
const TRUSTED_DAP_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  debugpy: "horizoncode:dap:debugpy-adapter",
  lldb: "horizoncode:dap:lldb-dap",
})
const TRUSTED_REPL_SELECTORS = Object.freeze({
  python: "horizoncode:repl:python3",
  javascript: "horizoncode:repl:node",
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function identifier(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    utf8Length(value) > maxBytes || controlCharacters.test(value) || /\s/.test(value)
  ) throw new TypeError(`${name} is invalid`)
}

function revision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_U64) {
    throw new TypeError("launch profile revision must be a positive canonical u64 decimal string")
  }
}

function hasInterpolation(value: string): boolean {
  return /\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%/.test(value)
}

/** Strictly validate the definition before sending it to authenticated IPC. */
export function validateExecutionLaunchProfileDefinitionV1(
  input: unknown,
): ExecutionLaunchProfileDefinitionV1 {
  if (!record(input) || !exactKeys(input, [
    "schemaVersion", "profileId", "revision", "kind", "executableSelector", "argv",
    "workingDirectoryPolicy", "environmentPolicy",
  ], ["dapPolicy"])) throw new TypeError("launch profile definition has unknown or missing fields")
  if (input.schemaVersion !== 1) throw new TypeError("unsupported launch profile schema version")
  if (typeof input.profileId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.profileId)) {
    throw new TypeError("launch profile ID is invalid")
  }
  revision(input.revision)
  if (input.kind !== "lsp" && input.kind !== "dap" && input.kind !== "repl") {
    throw new TypeError("launch profile kind is invalid")
  }
  if (input.dapPolicy !== undefined) {
    if (input.kind !== "dap" || !record(input.dapPolicy) || !exactKeys(input.dapPolicy, ["allowEvaluate"]) ||
        typeof input.dapPolicy.allowEvaluate !== "boolean") {
      throw new TypeError("launch profile DAP policy is invalid or attached to a non-DAP profile")
    }
  }
  if (typeof input.executableSelector !== "string" || !input.executableSelector ||
      utf8Length(input.executableSelector) > MAX_SELECTOR_BYTES || controlCharacters.test(input.executableSelector)) {
    throw new TypeError("launch profile executable selector is invalid")
  }
  const trustedSelectors = input.kind === "lsp" ? Object.values(LEGACY_LSP_SELECTORS)
    : input.kind === "dap" ? Object.values(TRUSTED_DAP_SELECTORS)
    : Object.values(TRUSTED_REPL_SELECTORS)
  if (!trustedSelectors.includes(input.executableSelector)) {
    throw new TypeError("launch profile executable selector is not approved for its process kind")
  }
  if (!Array.isArray(input.argv) || input.argv.length > MAX_ARG_COUNT) {
    throw new TypeError("launch profile argv exceeds its bound")
  }
  let totalArgBytes = 0
  for (const [index, arg] of input.argv.entries()) {
    if (typeof arg !== "string" || controlCharacters.test(arg) || hasInterpolation(arg) || utf8Length(arg) > MAX_ARG_BYTES) {
      throw new TypeError(`launch profile argv[${index}] is invalid`)
    }
    totalArgBytes += utf8Length(arg)
    if (totalArgBytes > MAX_TOTAL_ARG_BYTES) throw new TypeError("launch profile argv exceeds its total byte bound")
  }
  if (input.workingDirectoryPolicy !== "registered_location_root" || input.environmentPolicy !== "sanitized_host") {
    throw new TypeError("launch profile process policies are not supported")
  }
  return Object.freeze({
    schemaVersion: 1,
    profileId: input.profileId,
    revision: input.revision,
    kind: input.kind,
    executableSelector: input.executableSelector,
    argv: Object.freeze([...input.argv]),
    workingDirectoryPolicy: "registered_location_root",
    environmentPolicy: "sanitized_host",
    ...(input.dapPolicy === undefined
      ? {}
      : { dapPolicy: Object.freeze({ allowEvaluate: input.dapPolicy.allowEvaluate }) }),
  })
}

/**
 * Adapt an explicit legacy LSP entry from Config.getGlobal() to the immutable
 * HostKernel contract. Only the four installation-owned selectors are
 * accepted. A content-derived profile ID makes each distinct command vector a
 * separate immutable definition (revision 1); edits cannot silently retarget
 * an already pinned profile. Workspace/project Config must never be passed
 * here. Paths, shell names, environment overrides and arbitrary executables
 * are rejected/omitted so the selector remains HostKernel-owned.
 */
export function projectGlobalLspConfigProfileV1(input: {
  readonly serverID: string
  readonly configEntry: unknown
}): ExecutionLaunchProfileDefinitionV1 | undefined {
  identifier(input.serverID, "LSP server ID", 160)
  if (!record(input.configEntry)) return undefined
  if (input.configEntry.disabled === true) return undefined
  if (!Array.isArray(input.configEntry.command) || input.configEntry.command.length === 0) return undefined
  if (input.configEntry.env !== undefined &&
      (!record(input.configEntry.env) || Object.keys(input.configEntry.env).length > 0)) return undefined
  const [selectorName, ...argv] = input.configEntry.command
  if (typeof selectorName !== "string" || !Object.hasOwn(LEGACY_LSP_SELECTORS, selectorName)) return undefined
  const executableSelector = LEGACY_LSP_SELECTORS[selectorName]
  if (!executableSelector) return undefined
  // A named server profile cannot borrow another executable class just by
  // changing its command; aliases are fixed in the HostKernel selector map.
  const expectedName = input.serverID === "typescript" ? "typescript-language-server"
    : input.serverID === "rust" ? "rust-analyzer"
      : input.serverID === "pyright" ? "pyright-langserver"
        : input.serverID === "pylsp" ? "pylsp" : undefined
  if (expectedName !== selectorName) return undefined
  const normalizedArgv = argv.map((arg) => {
    if (typeof arg !== "string") throw new TypeError("LSP Config command arguments must be strings")
    return arg
  })
  const identity = createHash("sha256")
    .update(JSON.stringify([input.serverID, selectorName, normalizedArgv]))
    .digest("hex")
    .slice(0, 24)
  return validateExecutionLaunchProfileDefinitionV1({
    schemaVersion: 1,
    profileId: `lsp_${input.serverID}_${identity}`,
    revision: "1",
    kind: "lsp",
    executableSelector,
    argv: normalizedArgv,
    workingDirectoryPolicy: "registered_location_root",
    environmentPolicy: "sanitized_host",
  })
}

/** Project only the two HostKernel-owned DAP adapter selectors from trusted global Core Config. */
export function projectGlobalDapConfigProfileV1(input: {
  readonly adapterID: string
  readonly configEntry: unknown
}): ExecutionLaunchProfileDefinitionV1 | undefined {
  identifier(input.adapterID, "DAP adapter ID", 160)
  if (!record(input.configEntry) || input.configEntry.disabled === true) return undefined
  if (!exactKeys(input.configEntry, ["command"], ["disabled", "dapPolicy"])) return undefined
  const dapPolicy = input.configEntry.dapPolicy
  if (dapPolicy !== undefined && (!record(dapPolicy) || !exactKeys(dapPolicy, ["allowEvaluate"]) ||
      typeof dapPolicy.allowEvaluate !== "boolean")) return undefined
  if (!Array.isArray(input.configEntry.command) || input.configEntry.command.length === 0) return undefined
  const [selectorName, ...argv] = input.configEntry.command
  if (typeof selectorName !== "string" || !Object.hasOwn(TRUSTED_DAP_SELECTORS, selectorName)) return undefined
  const expectedSelector = input.adapterID === "debugpy" ? "debugpy"
    : input.adapterID === "lldb" ? "lldb" : undefined
  if (selectorName !== expectedSelector) return undefined
  const executableSelector = TRUSTED_DAP_SELECTORS[selectorName]
  if (!executableSelector) return undefined
  const normalizedArgv = argv.map((arg) => {
    if (typeof arg !== "string") throw new TypeError("DAP Config command arguments must be strings")
    return arg
  })
  const identity = createHash("sha256")
    .update(JSON.stringify([input.adapterID, selectorName, normalizedArgv, dapPolicy?.allowEvaluate === true]))
    .digest("hex")
    .slice(0, 24)
  return validateExecutionLaunchProfileDefinitionV1({
    schemaVersion: 1,
    profileId: `dap_${input.adapterID}_${identity}`,
    revision: "1",
    kind: "dap",
    executableSelector,
    argv: normalizedArgv,
    workingDirectoryPolicy: "registered_location_root",
    environmentPolicy: "sanitized_host",
    dapPolicy: { allowEvaluate: dapPolicy?.allowEvaluate === true },
  })
}

/** Consume the narrow value returned by Config.getGlobalLaunchProfiles(). */
export function projectTrustedGlobalDapProfileV1(input: {
  readonly config: GlobalLaunchProfilesConfig
  readonly adapterID: string
}): ExecutionLaunchProfileDefinitionV1 | undefined {
  const dap = input.config.dap
  if (typeof dap !== "object" || dap === null) return undefined
  return projectGlobalDapConfigProfileV1({ adapterID: input.adapterID, configEntry: dap[input.adapterID] })
}

/** Consume the narrow value returned by Config.getGlobalLaunchProfiles(). */
export function projectTrustedGlobalLspProfileV1(input: {
  readonly config: GlobalLaunchProfilesConfig
  readonly serverID: string
}): ExecutionLaunchProfileDefinitionV1 | undefined {
  const lsp = input.config.lsp
  if (typeof lsp !== "object" || lsp === null) return undefined
  return projectGlobalLspConfigProfileV1({ serverID: input.serverID, configEntry: lsp[input.serverID] })
}

/** Project the fixed HostKernel-owned interpreter selector for one supported language.
 * No user/project config can choose an executable or add launch arguments. */
export function projectTrustedReplProfileV1(input: {
  readonly language: "python" | "javascript"
}): ExecutionLaunchProfileDefinitionV1 {
  const python = input.language === "python"
  return validateExecutionLaunchProfileDefinitionV1({
    schemaVersion: 1,
    profileId: python ? "repl_python" : "repl_javascript",
    revision: "1",
    kind: "repl",
    executableSelector: TRUSTED_REPL_SELECTORS[input.language],
    argv: python ? ["-I", "-u", "-i"] : ["--interactive"],
    workingDirectoryPolicy: "registered_location_root",
    environmentPolicy: "sanitized_host",
  })
}

/**
 * Resolve an immutable Core Config profile through authenticated HostKernel
 * IPC. The resolver returns an approval challenge, never process launch
 * authority. The caller must complete the ordinary approval/one-use-lease
 * flow before prepare/launch; no local fallback exists.
 */
export async function resolveExecutionLaunchProfileV1(input: {
  readonly definition: ExecutionLaunchProfileDefinitionV1
  readonly scope: LaunchProfileResolutionScopeV1
    readonly requestHostKernel: (
      serviceID: "execution.v1",
      operation: "resolve_launch_profile",
      body: Readonly<Record<string, unknown>>,
    ) => Promise<unknown>
}): Promise<LaunchProfileApprovalV1> {
  const definition = validateExecutionLaunchProfileDefinitionV1(input.definition)
  for (const [field, value] of Object.entries({
    locationID: input.scope.locationID,
    sessionID: input.scope.sessionID,
    userActionID: input.scope.userActionID,
    callID: input.scope.callID,
  })) identifier(value, `launch profile ${field}`, 160)
  if (input.scope.managedAttempt !== undefined && input.scope.directAttempt !== undefined) {
    throw new TypeError("launch profile scope cannot claim both managed and direct Attempt authority")
  }
  // Attempt scope is authority-bearing data. Validate the full exact shape and
  // its identity pins before sending it over private IPC; do not pass mutable
  // caller objects through to the transport.
  const managedAttempt = input.scope.managedAttempt === undefined
    ? undefined
    : validateLaunchManagedAttempt(input.scope.managedAttempt, input.scope.sessionID, input.scope.locationID)
  const directAttempt = input.scope.directAttempt === undefined
    ? undefined
    : validateLaunchDirectAttempt(input.scope.directAttempt, input.scope.sessionID, input.scope.locationID)
  const body = Object.freeze({
    locationID: input.scope.locationID,
    sessionID: input.scope.sessionID,
    userActionID: input.scope.userActionID,
    callID: input.scope.callID,
    profileDefinition: definition,
    ...(managedAttempt === undefined ? {} : { managedAttempt }),
    ...(directAttempt === undefined ? {} : { directAttempt }),
  })
  const raw = await input.requestHostKernel("execution.v1", "resolve_launch_profile", body)
  const responseKeys = [
    "status", "challengeID", "effectID", "capabilityID", "locationID", "sessionID", "profileRef",
    "inputDigest", "expiresAtUnixMs", "normalizedTargets", "targets", "policySummary", "allowEnabled",
    "argumentSummary", "guaranteeAssessment", "noResponse", "normalizedAction", "origin", "policyDigest",
    "policyID", "requestedGuarantees", "source",
  ]
  if (!record(raw) || !exactKeys(raw, responseKeys) || raw.status !== "needs_approval") {
    throw new TypeError("HostKernel did not return a Guard approval challenge for the launch profile")
  }
  for (const field of ["challengeID", "effectID", "capabilityID", "locationID", "sessionID"] as const) {
    identifier(raw[field], `HostKernel launch approval ${field}`, 160)
  }
  const expectedCapability = definition.kind === "lsp" ? "language.start"
    : definition.kind === "dap" ? "debug.start" : "repl.start"
  if (!expectedCapability || raw.capabilityID !== expectedCapability) {
    throw new TypeError("HostKernel launch approval capability does not match the profile kind")
  }
  if (raw.locationID !== input.scope.locationID || raw.sessionID !== input.scope.sessionID) {
    throw new TypeError("HostKernel launch approval is bound to a different Location or Session")
  }
  const profileRef = validateExecutionLaunchProfileRef(raw.profileRef)
  if (profileRef.profileId !== definition.profileId || profileRef.revision !== definition.revision) {
    throw new TypeError("HostKernel launch profile reference differs from the projected Core Config revision")
  }
  const now = Date.now()
  const expiresAtUnixMs = raw.expiresAtUnixMs
  const inputDigest = raw.inputDigest
  const policyDigest = raw.policyDigest
  const policyID = raw.policyID
  const normalizedTargets = raw.normalizedTargets
  const targets = raw.targets
  const requestedGuarantees = raw.requestedGuarantees
  const guaranteeAssessment = raw.guaranteeAssessment
  const argumentSummary = raw.argumentSummary
  if (
    typeof inputDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
    typeof expiresAtUnixMs !== "number" || !Number.isSafeInteger(expiresAtUnixMs) ||
    expiresAtUnixMs <= now || expiresAtUnixMs > now + 5 * 60 * 1000 ||
    !Array.isArray(normalizedTargets) || normalizedTargets.length === 0 || normalizedTargets.length > 64 ||
    !Array.isArray(targets) || JSON.stringify(targets) !== JSON.stringify(normalizedTargets) ||
    Buffer.byteLength(JSON.stringify(normalizedTargets), "utf8") > 64 * 1024 ||
    typeof policyID !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(policyID) ||
    typeof policyDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(policyDigest) ||
    raw.origin !== "user_action" || raw.source !== "authenticated.user_action" ||
    raw.normalizedAction !== expectedCapability || raw.noResponse !== "deny_and_expire" ||
    typeof raw.allowEnabled !== "boolean" || typeof raw.policySummary !== "string" ||
    !raw.policySummary.trim() || Buffer.byteLength(raw.policySummary, "utf8") > 1024 ||
    !Array.isArray(requestedGuarantees) || requestedGuarantees.length === 0 || requestedGuarantees.length > 16 ||
    requestedGuarantees.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item)) ||
    new Set(requestedGuarantees).size !== requestedGuarantees.length ||
    !record(argumentSummary) || !record(guaranteeAssessment)
  ) throw new TypeError("HostKernel launch approval consent projection is invalid")
  const parsedSummary = argumentSummary.status === "available" && exactKeys(argumentSummary, ["status", "text"]) &&
    typeof argumentSummary.text === "string" && argumentSummary.text.trim().length > 0 &&
    Buffer.byteLength(argumentSummary.text, "utf8") <= 512
    ? { status: "available" as const, text: argumentSummary.text }
    : argumentSummary.status === "unavailable" && exactKeys(argumentSummary, ["status", "reason"]) &&
      typeof argumentSummary.reason === "string" && Buffer.byteLength(argumentSummary.reason, "utf8") <= 256
      ? { status: "unavailable" as const, reason: argumentSummary.reason }
      : undefined
  let parsedAssessment: GuardApprovalRequest["guaranteeAssessment"] | undefined
  if (guaranteeAssessment.status === "assessed" && exactKeys(guaranteeAssessment, ["status", "residual"]) &&
    Array.isArray(guaranteeAssessment.residual) && guaranteeAssessment.residual.length <= 16 &&
    guaranteeAssessment.residual.every((item) => typeof item === "string" && requestedGuarantees.includes(item)) &&
    new Set(guaranteeAssessment.residual).size === guaranteeAssessment.residual.length) {
    parsedAssessment = { status: "assessed", residual: [...guaranteeAssessment.residual] as string[] }
  } else if (guaranteeAssessment.status === "not_assessed" && exactKeys(guaranteeAssessment, ["status", "residual"]) &&
    guaranteeAssessment.residual === null) {
    parsedAssessment = { status: "not_assessed", residual: null }
  }
  if (!parsedSummary || !parsedAssessment || raw.allowEnabled !== (parsedSummary.status === "available" && parsedAssessment.status === "assessed")) {
    throw new TypeError("HostKernel launch approval assessment is incomplete or inconsistent")
  }
  const approval = Object.freeze({
    challengeID: raw.challengeID as string,
    effectID: raw.effectID as string,
    capabilityID: expectedCapability,
    locationID: raw.locationID as string,
    sessionID: raw.sessionID as string,
    inputDigest,
    normalizedTargets: Object.freeze([...normalizedTargets]),
    expiresAtUnixMs,
    policySummary: raw.policySummary as string,
    origin: "user_action" as const,
    source: "authenticated.user_action" as const,
    policyID,
    policyDigest,
    normalizedAction: expectedCapability,
    argumentSummary: parsedSummary,
    requestedGuarantees: Object.freeze([...requestedGuarantees]) as readonly string[],
    guaranteeAssessment: parsedAssessment,
    noResponse: "deny_and_expire" as const,
    allowEnabled: raw.allowEnabled as boolean,
  })
  return Object.freeze({
    status: "needs_approval",
    challengeID: raw.challengeID,
    effectID: raw.effectID,
    capabilityID: expectedCapability,
    locationID: raw.locationID,
    sessionID: raw.sessionID,
    profileRef,
    approval,
  })
}

/** Parse HostKernel's exact launch approval response without performing another RPC. */
export function decodeExecutionLaunchProfileApprovalV1(input: {
  readonly response: unknown
  readonly definition: ExecutionLaunchProfileDefinitionV1
  readonly scope: LaunchProfileResolutionScopeV1
}): Promise<LaunchProfileApprovalV1> {
  return resolveExecutionLaunchProfileV1({
    definition: input.definition,
    scope: input.scope,
    requestHostKernel: async () => input.response,
  })
}

/**
 * Single Core Config → HostKernel launch-profile entry point. It deliberately
 * consumes only the global-only projection returned by Config; callers cannot
 * supply a project/plugin config object and then accidentally treat it as
 * trusted authority. A missing/disabled/unapproved profile is unavailable,
 * with no executable or local-launch fallback.
 */
export async function resolveTrustedGlobalLaunchProfileV1(input: {
  readonly config: GlobalLaunchProfilesConfig
  readonly kind: "lsp" | "dap" | "repl"
  readonly selectorID: string
  readonly scope: LaunchProfileResolutionScopeV1
  readonly requestHostKernel: (
    serviceID: "execution.v1",
    operation: "resolve_launch_profile",
    body: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>
}): Promise<LaunchProfileApprovalV1 | undefined> {
  const definition = input.kind === "lsp"
    ? projectTrustedGlobalLspProfileV1({ config: input.config, serverID: input.selectorID })
    : input.kind === "dap"
      ? projectTrustedGlobalDapProfileV1({ config: input.config, adapterID: input.selectorID })
      : input.selectorID === "python" || input.selectorID === "javascript"
        ? projectTrustedReplProfileV1({ language: input.selectorID })
        : undefined
  if (!definition) return undefined
  return resolveExecutionLaunchProfileV1({
    definition,
    scope: input.scope,
    requestHostKernel: input.requestHostKernel,
  })
}

/** Resolve the fixed language profile through the same authenticated HostKernel
 * approval path. The profile selector is built in and the result alone does not
 * grant interpreter process or callback authority. */
export async function resolveTrustedReplLaunchProfileV1(input: {
  readonly language: "python" | "javascript"
  readonly scope: LaunchProfileResolutionScopeV1
  readonly requestHostKernel: (
    serviceID: "execution.v1",
    operation: "resolve_launch_profile",
    body: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>
}): Promise<LaunchProfileApprovalV1> {
  return resolveExecutionLaunchProfileV1({
    definition: projectTrustedReplProfileV1({ language: input.language }),
    scope: input.scope,
    requestHostKernel: input.requestHostKernel,
  })
}

function validateLaunchManagedAttempt(
  input: ManagedAttemptScopeV1,
  sessionID: string,
  locationID: string,
): ManagedAttemptScopeV1 {
  if (!record(input) || !exactKeys(input as unknown as Record<string, unknown>, [
    "goalID", "runID", "taskID", "attemptID", "ownerEpoch", "expectedManagedRevision",
    "locationID", "sessionID", "workspaceRevision", "effectiveMaxTokens", "remainingTokens", "delegationBindingDigest",
  ])) throw new TypeError("managed launch Attempt scope is malformed")
  if (input.sessionID !== sessionID || input.locationID !== locationID ||
    !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) || BigInt(input.ownerEpoch) > MAX_U64 ||
    !/^(0|[1-9][0-9]{0,19})$/.test(input.expectedManagedRevision) || BigInt(input.expectedManagedRevision) > MAX_U64 ||
    !/^[1-9][0-9]{0,19}$/.test(input.effectiveMaxTokens) || BigInt(input.effectiveMaxTokens) > MAX_U64 ||
    !/^[1-9][0-9]{0,19}$/.test(input.remainingTokens) || BigInt(input.remainingTokens) > BigInt(input.effectiveMaxTokens) ||
    !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision) ||
    !/^blake3:[0-9a-f]{64}$/.test(input.delegationBindingDigest)) {
    throw new TypeError("managed launch Attempt scope does not match its authenticated Session/Location pins")
  }
  for (const value of [input.goalID, input.runID, input.taskID, input.attemptID, input.sessionID, input.locationID]) {
    identifier(value, "managed launch Attempt identity", 256)
  }
  return Object.freeze({ ...input })
}

function validateLaunchDirectAttempt(
  input: DirectAttemptScopeV1,
  sessionID: string,
  locationID: string,
): DirectAttemptScopeV1 {
  if (!record(input) || !exactKeys(input as unknown as Record<string, unknown>, [
    "attemptID", "parentSessionID", "childSessionID", "profileID", "profileRevision", "profileDigest",
    "ownerEpoch", "expectedRevision", "locationID", "workspaceID", "workspaceRevision", "capabilityDigest",
    "permissionsDigest", "budgetDigest", "scopeDigest",
  ])) throw new TypeError("direct launch Attempt scope is malformed")
  if (input.childSessionID !== sessionID || input.locationID !== locationID ||
    !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) || BigInt(input.ownerEpoch) > MAX_U64 ||
    !/^(0|[1-9][0-9]{0,19})$/.test(input.expectedRevision) || BigInt(input.expectedRevision) > MAX_U64 ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(input.profileID) || !/^[1-9][0-9]{0,19}$/.test(input.profileRevision) ||
    BigInt(input.profileRevision) > MAX_U64) {
    throw new TypeError("direct launch Attempt scope does not match its authenticated Session/Location pins")
  }
  for (const digest of [input.profileDigest, input.workspaceRevision, input.capabilityDigest,
    input.permissionsDigest, input.budgetDigest, input.scopeDigest]) {
    if (!/^blake3:[0-9a-f]{64}$/.test(digest)) throw new TypeError("direct launch Attempt scope contains an invalid digest")
  }
  for (const value of [input.attemptID, input.parentSessionID, input.childSessionID, input.locationID, input.workspaceID]) {
    identifier(value, "direct launch Attempt identity", 256)
  }
  return Object.freeze({ ...input })
}
import { createHash } from "node:crypto"
