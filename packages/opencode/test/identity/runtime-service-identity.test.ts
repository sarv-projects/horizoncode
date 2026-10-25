import { expect, test } from "bun:test"
import { resolve } from "node:path"

const source = resolve(import.meta.dir, "../../src")

const releasedRuntimeIds: Record<string, ReadonlyArray<string>> = {
  "acp/directory.ts": ["@horizoncode/ACPDirectoryLoader", "@horizoncode/ACPDirectory"],
  "acp/service.ts": ["@horizoncode/ACP/Service"],
  "acp/session.ts": ["@horizoncode/ACP/Session"],
  "acp/usage.ts": [
    "@horizoncode/ACPUsageMessageLoader",
    "@horizoncode/ACPUsageContextLimitLoader",
    "@horizoncode/ACPUsage",
  ],
  "account/account.ts": ["@horizoncode/Account"],
  "account/repo.ts": ["@horizoncode/AccountRepo"],
  "agent/agent.ts": ["@horizoncode/Agent"],
  "command/index.ts": ["@horizoncode/Command"],
  "config/config.ts": ["@horizoncode/Config"],
  "config/tui.ts": ["@horizoncode/TuiConfig"],
  "control-plane/workspace.ts": ["@horizoncode/Workspace"],
  "effect/runtime-flags.ts": ["@horizoncode/RuntimeFlags"],
  "env/index.ts": ["@horizoncode/Env"],
  "event-v2-bridge.ts": ["@horizoncode/EventV2Bridge"],
  "format/index.ts": ["@horizoncode/Format"],
  "git/index.ts": ["@horizoncode/Git"],
  "image/image.ts": ["@horizoncode/Image"],
  "installation/index.ts": ["@horizoncode/Installation"],
  "lsp/lsp.ts": ["@horizoncode/LSPExecutionScope", "@horizoncode/LSP"],
  "mcp/auth.ts": ["@horizoncode/McpAuth"],
  "mcp/browser.ts": ["@horizoncode/McpBrowser"],
  "mcp/index.ts": ["@horizoncode/MCP"],
  "permission/index.ts": ["@horizoncode/Permission"],
  "plugin/index.ts": ["@horizoncode/Plugin"],
  "project/bootstrap-service.ts": ["@horizoncode/InstanceBootstrap"],
  "project/project.ts": ["@horizoncode/Project"],
  "project/vcs.ts": ["@horizoncode/Vcs"],
  "question/index.ts": ["@horizoncode/Question"],
  "server/routes/instance/httpapi/middleware/authorization.ts": [
    "@horizoncode/ExperimentalHttpApiAuthorization",
    "@horizoncode/ExperimentalHttpApiPtyConnectAuthorization",
  ],
  "server/routes/instance/httpapi/middleware/instance-context.ts": ["@horizoncode/ExperimentalHttpApiInstanceContext"],
  "server/routes/instance/httpapi/middleware/schema-error.ts": ["@horizoncode/HttpApiSchemaError"],
  "server/routes/instance/httpapi/middleware/workspace-routing.ts": [
    "@horizoncode/ExperimentalHttpApiWorkspaceRouteContext",
    "@horizoncode/ExperimentalHttpApiWorkspaceRouting",
  ],
  "server/routes/instance/httpapi/websocket-tracker.ts": ["@horizoncode/HttpApiWebSocketTracker"],
  "session/compaction.ts": ["@horizoncode/SessionCompaction"],
  "session/processor.ts": ["@horizoncode/SessionProcessor"],
  "session/run-state.ts": ["@horizoncode/SessionRunState"],
  "session/session.ts": ["@horizoncode/Session"],
  "session/status.ts": ["@horizoncode/SessionStatus"],
  "session/summary.ts": ["@horizoncode/SessionSummary"],
  "session/todo.ts": ["@horizoncode/SessionTodo"],
  "skill/discovery.ts": ["@horizoncode/SkillDiscovery"],
  "skill/index.ts": ["@horizoncode/Skill"],
  "snapshot/index.ts": ["@horizoncode/Snapshot"],
  "storage/storage.ts": ["@horizoncode/Storage"],
  "tool/artifact-search.ts": ["@horizoncode/ArtifactSearch"],
  "tool/registry.ts": ["@horizoncode/ToolRegistry"],
  "tool/repo-intel.ts": ["@horizoncode/RepoIntel"],
  "tool/truncate.ts": ["@horizoncode/Truncate"],
  "tool/websearch-runtime.ts": ["@horizoncode/WebSearchRuntime"],
  "share/session.ts": ["@horizoncode/SessionShare"],
  "share/share-next.ts": ["@horizoncode/ShareNext"],
  "worktree/index.ts": ["@horizoncode/Worktree"],
  "server/server.ts": ["@horizoncode/ListenerServer"],
}

test("released runtime Context tags use HorizonCode identity", async () => {
  for (const [path, expected] of Object.entries(releasedRuntimeIds)) {
    const text = await Bun.file(resolve(source, path)).text()
    const actual: ReadonlyArray<string> = [...text.matchAll(/["'](@(?:opencode|horizoncode)\/[^"']+)["']/g)].map(
      (match) => match[1],
    )

    expect(actual, path).toEqual(expected)
  }
})

test("provider-related runtime Context tags retain OpenCode identity", async () => {
  const preservedProviderIds: Record<string, string> = {
    "provider/provider.ts": "@opencode/Provider",
    "provider/auth.ts": "@opencode/ProviderAuth",
    "auth/index.ts": "@opencode/Auth",
    "session/llm.ts": "@opencode/LLM",
  }

  for (const [path, expected] of Object.entries(preservedProviderIds)) {
    const text = await Bun.file(resolve(source, path)).text()

    expect(text).toContain(`"${expected}"`)
  }
})
