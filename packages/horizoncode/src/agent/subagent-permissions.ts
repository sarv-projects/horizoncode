import { PermissionV1 } from "@horizoncode/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. Parent-session restrictions and external_directory rules.
 * 2. Non-allow restrictions from the parent agent profile. A child profile
 *    cannot override a parent-profile deny or turn an ask into an allow.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentAgentPermission: PermissionV1.Ruleset
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentRestrictions = [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action !== "allow",
    ),
    ...input.parentAgentPermission.filter((rule) => rule.action !== "allow"),
  ]
  return [
    ...parentRestrictions.filter((rule) => rule.action !== "deny"),
    ...parentRestrictions.filter((rule) => rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
