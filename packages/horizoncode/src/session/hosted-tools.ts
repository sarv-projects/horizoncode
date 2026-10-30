/**
 * Hosted workflow providers can perform tools on their own infrastructure.
 * A callback or approval response received *after* remote execution is not
 * Rust Guard admission. Until a provider exposes a proven, enforceable
 * pre-dispatch control contract, do not send it a workflow request.
 *
 * This is an availability gate, not another permission system.
 */
export function requireMediatedWorkflowProvider(isHostedWorkflow: boolean): void {
  if (!isHostedWorkflow) return
  throw new Error(
    "Hosted workflow provider unavailable: server-side tools cannot be Rust Guard-authorized before remote execution.",
  )
}
