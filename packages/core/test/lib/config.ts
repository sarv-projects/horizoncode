import { Effect } from "effect"
import { Config } from "@opencode-ai/core/config"

/**
 * Fail-closed Config.Interface members that tests which only exercise `entries`
 * must still provide. The trusted Git executable is absent and the workspace
 * command profiles are empty, so a test cannot accidentally resolve a profile
 * or a Git binary it never intended to configure.
 */
export const configServiceMockDefaults = {
  trustedGitExecutable: () => Effect.succeed(undefined),
  workspaceCommandProfiles: () => Effect.succeed([]),
  workspaceCommandProfile: () => Effect.fail(new Error("no workspace command profile is configured in this test")),
} satisfies Pick<
  Config.Interface,
  "trustedGitExecutable" | "workspaceCommandProfiles" | "workspaceCommandProfile"
>
