import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { registerOpencodeSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider, useTuiStartup } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { StartupLoading } from "./component/startup-loading"
import { SyncProvider, useSync } from "./context/sync"
import { DataProvider } from "./context/data"
import { LocationProvider } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { PermissionProvider } from "./context/permission"
import { DialogModel } from "./component/dialog-model"
import { DialogSelect, type DialogSelectOption } from "./ui/dialog-select"
import {
  DialogGoalReview,
  type GoalReviewProjection,
} from "./component/dialog-goal-review"
import { DialogGoalVerification, type GoalVerificationResult } from "./component/dialog-goal-verification"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogGuardApproval } from "./component/dialog-guard-approval"
import { DialogProviderDoctor } from "./component/dialog-provider-doctor"
import { DialogFeatures } from "./component/dialog-features"
import { DialogWebSearchSettings } from "./component/dialog-websearch-settings"
import { DialogStatus } from "./component/dialog-status"
import { DialogDebug } from "./component/dialog-debug"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogPrompt } from "./ui/dialog-prompt"
import { DialogAgent } from "./component/dialog-agent"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogWorkspaceList } from "./component/dialog-workspace-list"
import { DialogConsoleOrg } from "./component/dialog-console-org"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { openUrl } from "@opencode-ai/core/open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import * as TuiAudio from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"

registerOpencodeSpinner()

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "console.org.switch",
  "opencode.status",
  "opencode.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "diff.open",
  "workspace.list",
  "provider.doctor.offline",
  "goal.review",
  "goal.propose",
  "web.search.settings",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2)
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference) return difference > 0
  }
  if (a.prerelease === b.prerelease) return false
  if (!a.prerelease) return true
  if (!b.prerelease) return false
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) > 0
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              externalOutputMode: "passthrough",
              targetFps: 60,
              gatherStats: false,
              exitOnCtrlC: false,
              useKittyKeyboard: {},
              autoFocus: false,
              openConsoleOnError: false,
              useMouse: !Flag.OPENCODE_DISABLE_MOUSE && input.config.mouse,
              consoleOptions: {
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
              },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      const pluginRuntime = createPluginRuntime()

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.OPENCODE_ROUTE ? JSON.parse(process.env.OPENCODE_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.OPENCODE_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <OpencodeKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <PluginRuntimeProvider value={pluginRuntime}>
                                        <SDKProvider
                                          url={input.url}
                                          directory={input.directory}
                                          fetch={input.fetch}
                                          headers={input.headers}
                                          events={input.events}
                                        >
                                          <PermissionProvider>
                                            <ProjectProvider>
                                              <SyncProvider>
                                                <DataProvider>
                                                  <ThemeProvider mode={mode}>
                                                    <LocalProvider>
                                                      <PromptStashProvider>
                                                        <DialogProvider>
                                                          <FrecencyProvider>
                                                            <PromptHistoryProvider>
                                                              <PromptRefProvider>
                                                                <EditorContextProvider>
                                                                  <LocationProvider>
                                                                    <App
                                                                      onSnapshot={input.onSnapshot}
                                                                      pluginHost={input.pluginHost}
                                                                    />
                                                                  </LocationProvider>
                                                                </EditorContextProvider>
                                                              </PromptRefProvider>
                                                            </PromptHistoryProvider>
                                                          </FrecencyProvider>
                                                        </DialogProvider>
                                                      </PromptStashProvider>
                                                    </LocalProvider>
                                                  </ThemeProvider>
                                                </DataProvider>
                                              </SyncProvider>
                                            </ProjectProvider>
                                          </PermissionProvider>
                                        </SDKProvider>
                                      </PluginRuntimeProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpencodeKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined) {
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
      process.exitCode = 1
    }
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: { onSnapshot?: () => Promise<string[]>; pluginHost: TuiPluginHost }) {
  const startup = useTuiStartup()
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  // Guard approvals are host-issued one-use challenges. Only open the earliest
  // unexpired request when no other dialog is using the shared modal surface.
  // Escape/backdrop close answers deny; the active signal prevents a second
  // challenge from replacing the first while its reply is in flight.
  const [guardApprovalReplying, setGuardApprovalReplying] = createSignal(false)
  createEffect(() => {
    const request = sync.guardApproval.pending()[0]
    if (!request || dialog.stack.length > 0 || guardApprovalReplying()) return
    let answered = false
    const reply = async (decision: "allow_once" | "deny") => {
      if (answered) return false
      answered = true
      setGuardApprovalReplying(true)
      try {
        return await sync.guardApproval.reply(request.approvalID, decision)
      } finally {
        setGuardApprovalReplying(false)
      }
    }
    dialog.replace(
      () => <DialogGuardApproval request={request} onDecision={reply} />,
      () => void reply("deny"),
    )
  })

  async function openGoalReviewInbox() {
    try {
      const response = await sdk.client.experimental.goalReview.goalReviews(
        {
          directory: sdk.directory,
          workspace: project.workspace.current(),
          limit: "64",
        },
        { throwOnError: true },
      )
      const proposals = response.data.goals.flatMap((goal) => goal.proposals).slice(0, 64)
      if (proposals.length === 0) {
        void DialogAlert.show(dialog, "Goal review", "No proposed SpecVersion is awaiting review in this workspace.")
        return
      }
      const options: DialogSelectOption<GoalReviewProjection>[] = proposals.map((proposal) => ({
        title: `${proposal.goalId} · ${proposal.specVersionId}`,
        value: proposal,
        description: proposal.objective,
        details: [
          `Revision ${proposal.goalRevision}`,
          `Proposed by ${proposal.proposedBy}`,
          `Digest ${proposal.specDigest}`,
          proposal.reviewAvailability.available
            ? "Authenticated reviewer available"
            : `Decision unavailable: ${proposal.reviewAvailability.reason}`,
        ],
      }))
      dialog.replace(() => (
        <DialogSelect
          title="Goal · Pending SpecVersion reviews"
          options={options}
          onSelect={(option) => {
            const proposal = option.value
            dialog.replace(() => (
              <DialogGoalReview
                proposal={proposal}
                onAccept={async (decision) => {
                  await sdk.client.experimental.goalReview.goalReviewDecision(
                    {
                      directory: sdk.directory,
                      workspace: project.workspace.current(),
                      decision: "accept",
                      goalID: decision.goalId,
                      specID: decision.specVersionId,
                      specDigest: decision.specDigest,
                      expectedRevision: decision.expectedRevision,
                    },
                    { throwOnError: true },
                  )
                }}
                onReject={async (decision) => {
                  await sdk.client.experimental.goalReview.goalReviewDecision(
                    {
                      directory: sdk.directory,
                      workspace: project.workspace.current(),
                      decision: "reject",
                      goalID: decision.goalId,
                      specID: decision.specVersionId,
                      specDigest: decision.specDigest,
                      expectedRevision: decision.expectedRevision,
                    },
                    { throwOnError: true },
                  )
                }}
              />
            ))
          }}
        />
      ))
    } catch (error) {
      toast.error(error)
    }
  }

  async function openGoalProposal() {
    let pending = false
    dialog.replace(() => (
      <DialogPrompt
        title="Propose a managed Goal"
        placeholder='{"schemaVersion":1,"objective":"...","capabilityScope":[],"scope":[],"constraints":[],"criteria":[{"id":"...","description":"..."}],"budget":{"maxTasks":1,"maxAttemptsPerTask":1,"maxRunDurationMs":60000,"maxWorkers":1},"sourceDigests":[]}'
        description={() => (
          <text>
            Paste one schemaVersion 1 JSON draft (32 KiB max). The server binds it to this project and workspace,
            creates IDs, and sends the proposal to the Goal review inbox.
          </text>
        )}
        onConfirm={(value) => {
          if (pending) return
          pending = true
          void (async () => {
            try {
              if (new TextEncoder().encode(value).byteLength > 32 * 1024)
                throw new Error("Draft exceeds the 32 KiB limit")
              const parsed: unknown = JSON.parse(value)
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
                throw new Error("Draft must be a JSON object")
              const draft = parsed as Record<string, unknown>
              if (draft.schemaVersion !== 1) throw new Error("Draft must use schemaVersion 1")
              if (
                typeof draft.objective !== "string" ||
                !Array.isArray(draft.capabilityScope) ||
                !Array.isArray(draft.scope) ||
                !Array.isArray(draft.constraints) ||
                !Array.isArray(draft.criteria) ||
                typeof draft.budget !== "object" ||
                draft.budget === null ||
                !Array.isArray(draft.sourceDigests)
              ) {
                throw new Error("Draft is missing a required schemaVersion 1 field")
              }
              const response = await sdk.client.experimental.goalReview.goalPropose(
                {
                  directory: sdk.directory,
                  workspace: project.workspace.current(),
                  schemaVersion: 1,
                  objective: draft.objective,
                  capabilityScope: draft.capabilityScope as string[],
                  scope: draft.scope as string[],
                  constraints: draft.constraints as string[],
                  criteria: draft.criteria as Array<{ id: string; description: string }>,
                  budget: draft.budget as {
                    maxTasks: number
                    maxAttemptsPerTask: number
                    maxRunDurationMs: number
                    maxWorkers: number
                    maxMemoryBytes?: number
                    maxDiskBytes?: number
                    maxTokens?: number
                    maxCostMicros?: number
                  },
                  sourceDigests: draft.sourceDigests as string[],
                },
                { throwOnError: true },
              )
              dialog.clear()
              toast.show({
                message: `Goal proposal ${response.data.goalID} · ${response.data.specID} sent for review`,
                variant: "info",
              })
            } catch (error) {
              pending = false
              toast.error(error)
            }
          })()
        }}
      />
    ))
  }

  function openGoalVerification() {
    dialog.replace(() => (
      <DialogPrompt
        title="Verify an accepted managed Run"
        placeholder="goalID runID"
        description={() => <text>Enter the accepted Goal ID and current Run ID, separated by one space.</text>}
        onConfirm={(value) => {
          const parts = value.trim().split(/\s+/)
          if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]{1,256}$/.test(part))) {
            toast.error("Enter exactly one Goal ID and one Run ID")
            return
          }
          const [goalID, runID] = parts
          dialog.replace(() => (
            <DialogGoalVerification
              goalID={goalID}
              runID={runID}
              onVerify={async (): Promise<GoalVerificationResult> => {
                const response = await sdk.client.experimental.goalReview.goalVerification(
                  {
                    directory: sdk.directory,
                    workspace: project.workspace.current(),
                    schemaVersion: 1,
                    goalID,
                    runID,
                  },
                  { throwOnError: true },
                )
                if (response.data.goalID !== goalID || response.data.runID !== runID) {
                  throw new Error("Verification response does not match the requested Goal and Run")
                }
                if (response.data.status === "ABORTED") {
                  if (!response.data.reason) throw new Error("Aborted verification response has no reason")
                  return {
                    status: "ABORTED",
                    reason: response.data.reason,
                    revision: response.data.revision,
                  }
                }
                return { status: response.data.status, revision: response.data.revision }
              }}
            />
          ))
        }}
      />
    ))
  }

  function openGoalRunControl() {
    dialog.replace(() => (
      <DialogPrompt
        title="Control a managed Run"
        placeholder="goalID runID pause|resume|cancel"
        description={() => <text>Enter the Goal ID, Run ID, and one action, separated by spaces.</text>}
        onConfirm={(value) => {
          const parts = value.trim().split(/\s+/)
          if (
            parts.length !== 3 ||
            parts.slice(0, 2).some((part) => !/^[A-Za-z0-9._-]{1,256}$/.test(part)) ||
            !["pause", "resume", "cancel"].includes(parts[2])
          ) {
            toast.error("Enter a Goal ID, Run ID, and pause, resume, or cancel")
            return
          }
          const [goalID, runID, action] = parts as [string, string, "pause" | "resume" | "cancel"]
          void (async () => {
            try {
              const current = await sdk.client.experimental.goalReview.goalReview(
                { directory: sdk.directory, workspace: project.workspace.current(), goalID },
                { throwOnError: true },
              )
              if (current.data.goalID !== goalID) throw new Error("Run control snapshot belongs to a different Goal")
              const run = current.data.runs.find((item) => item.runID === runID)
              if (!run) throw new Error("Run does not exist in the current Goal snapshot")
              const expectedRevision = current.data.goalRevision
              dialog.replace(() => (
                <DialogConfirm
                  title={`${action[0]!.toUpperCase()}${action.slice(1)} managed Run?`}
                  message={`Run ${runID} is ${run.runPhase} at Goal revision ${expectedRevision}. ${run.runPhase === "PLAN_ONLY" && action === "cancel" ? "This discards the unstarted plan without starting workers." : `Confirm ${action}.`}`}
                  onConfirm={async () => {
                    try {
                      const response = await sdk.client.experimental.goalReview.goalRunControl(
                        {
                          directory: sdk.directory,
                          workspace: project.workspace.current(),
                          schemaVersion: 1,
                          action,
                          goalID,
                          runID,
                          expectedRevision,
                        },
                        { throwOnError: true },
                      )
                      if (response.data.goalID !== goalID || response.data.runID !== runID) {
                        throw new Error("Run control response does not match the requested Goal and Run")
                      }
                      dialog.clear()
                      toast.show({
                        message: `Run ${runID}: ${response.data.status} · revision ${response.data.revision}`,
                        variant: "info",
                      })
                    } catch (error) {
                      toast.error(error)
                    }
                  }}
                />
              ))
            } catch (error) {
              toast.error(error)
            }
          })()
        }}
      />
    ))
  }

  function openGoalRunPlan() {
    let pending = false
    dialog.replace(() => (
      <DialogPrompt
        title="Plan tasks for an accepted Goal"
        placeholder='{"schemaVersion":1,"goalID":"goal_…","specID":"spec_…","specDigest":"blake3:…","expectedGoalRevision":"12","runID":"run_…","tasks":[{"taskID":"task_1","dependencies":[],"criterionIDs":["criterion_1"],"requiredCapabilities":["files.read"],"profileSelection":{"profileId":"default","revision":"1"}}]}'
        description={() => (
          <text>
            Paste one bounded dependency plan JSON. The server checks the accepted SpecVersion, profile pins, and
            current workspace. This records the exact DAG only: Tasks stay unready and no worker or effect is dispatched.
          </text>
        )}
        onConfirm={(value) => {
          if (pending) return
          pending = true
          void (async () => {
            try {
              if (new TextEncoder().encode(value).byteLength > 32 * 1024) throw new Error("Run plan exceeds the 32 KiB limit")
              const parsed: unknown = JSON.parse(value)
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Run plan must be a JSON object")
              const plan = parsed as Record<string, unknown>
              if (plan.schemaVersion !== 1 || typeof plan.goalID !== "string" || typeof plan.specID !== "string" ||
                typeof plan.specDigest !== "string" || typeof plan.expectedGoalRevision !== "string" ||
                typeof plan.runID !== "string" || !Array.isArray(plan.tasks)) {
                throw new Error("Run plan is missing a required schemaVersion 1 field")
              }
              const response = await sdk.client.experimental.goalReview.goalRunPlan({
                directory: sdk.directory,
                workspace: project.workspace.current(),
                schemaVersion: 1,
                goalID: plan.goalID,
                specID: plan.specID,
                specDigest: plan.specDigest,
                expectedGoalRevision: plan.expectedGoalRevision,
                runID: plan.runID,
                tasks: plan.tasks as Array<{
                  taskID: string
                  dependencies: string[]
                  criterionIDs: string[]
                  requiredCapabilities: string[]
                  profileSelection: { profileId: string; revision: string }
                }>,
              }, { throwOnError: true })
              if (response.data.status !== "PLAN_ONLY" || response.data.executionAvailable !== false || response.data.tasksReady !== false) {
                throw new Error("Server returned an invalid managed plan-only state")
              }
              dialog.clear()
              toast.show({
                message: `Run ${response.data.runID} planned · ${response.data.taskIDs.length} Tasks · execution unavailable`,
                variant: "info",
              })
            } catch (error) {
              pending = false
              toast.error(error)
            }
          })()
        }}
      />
    ))
  }

  function openGoalRunStart() {
    dialog.replace(() => (
      <DialogPrompt
        title="Start a planned managed Run"
        placeholder='{"schemaVersion":1,"goalID":"goal_…","runID":"run_…","idempotencyKey":"start_run_…"}'
        description={() => (
          <text>
            Enter the Goal and persisted plan to start. The accepted SpecVersion, revision, and exact plan are
            loaded from the current trusted snapshot. Starting only marks dependency-ready Task roots; Guard,
            Attempt admission, and each effect still require their own authorization.
          </text>
        )}
        onConfirm={(value) => {
          void (async () => {
            try {
              if (new TextEncoder().encode(value).byteLength > 8 * 1024) throw new Error("Run start request exceeds the 8 KiB limit")
              const parsed: unknown = JSON.parse(value)
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Run start must be a JSON object")
              const start = parsed as Record<string, unknown>
              if (start.schemaVersion !== 1 || typeof start.goalID !== "string" || typeof start.runID !== "string" ||
                typeof start.idempotencyKey !== "string" || start.goalID.length > 256 || start.runID.length > 256 ||
                start.idempotencyKey.length > 256) {
                throw new Error("Run start is missing a required schemaVersion 1 field")
              }
              const current = await sdk.client.experimental.goalReview.goalReview(
                { directory: sdk.directory, workspace: project.workspace.current(), goalID: start.goalID },
                { throwOnError: true },
              )
              const run = current.data.runs.find((item) => item.runID === start.runID)
              if (!run) throw new Error("Run does not exist in the current Goal snapshot")
              if (run.runPhase !== "PLAN_ONLY") throw new Error(`Run is already ${run.runPhase}; only a plan-only Run can be started here`)
              const acceptedSpec = current.data.acceptedSpecs.find((item) => item.specID === run.specID)
              if (!acceptedSpec) throw new Error("Run is not bound to a currently accepted SpecVersion")
              const authority = {
                goalID: start.goalID as string,
                runID: start.runID as string,
                specID: run.specID,
                specDigest: acceptedSpec.specDigest,
                expectedGoalRevision: current.data.goalRevision,
                idempotencyKey: start.idempotencyKey as string,
              }
              dialog.replace(() => (
                <DialogConfirm
                  title="Start this managed Run?"
                  message={`Run ${authority.runID} is ${run.runPhase} · accepted SpecVersion ${authority.specID} · Goal revision ${authority.expectedGoalRevision}. The server will reject stale authority; an exact replay is idempotent. Effect admission remains separately guarded.`}
                  onConfirm={async () => {
                    try {
                      const response = await sdk.client.experimental.goalReview.goalRunStart({
                        directory: sdk.directory,
                        workspace: project.workspace.current(),
                        schemaVersion: 1,
                        goalID: authority.goalID,
                        runID: authority.runID,
                        expectedGoalRevision: authority.expectedGoalRevision,
                        specID: authority.specID,
                        specDigest: authority.specDigest,
                        sessionID: route.data.sessionID,
                        idempotencyKey: authority.idempotencyKey,
                      }, { throwOnError: true })
                      if (response.data.goalID !== authority.goalID || response.data.runID !== authority.runID ||
                        response.data.sessionID !== route.data.sessionID) {
                        throw new Error("Server returned a different managed Run")
                      }
                      dialog.clear()
                      toast.show({ message: `Run ${response.data.runID} · ${response.data.runPhase} · revision ${response.data.revision}`, variant: "info" })
                    } catch (error) {
                      toast.error(error)
                    }
                  }}
                />
              ))
            } catch (error) {
              toast.error(error)
            }
          })()
        }}
      />
    ))
  }

  function automationSessionID() {
    if (route.data.type !== "session") throw new Error("Automation controls require an authenticated session in the current workspace")
    return route.data.sessionID
  }

  function safeAutomationText(value: unknown, maxBytes = 160) {
    const clean = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    const bytes = new TextEncoder().encode(clean)
    if (bytes.byteLength <= maxBytes) return clean
    return new TextDecoder().decode(bytes.slice(0, maxBytes)) + "…"
  }

  async function openAutomationManager() {
    try {
      const sessionID = automationSessionID()
      const response = await sdk.client.experimental.automation.list({
        directory: sdk.directory,
        workspace: project.workspace.current(),
        sessionID,
      }, { throwOnError: true })
      const automations = response.data.automations
      if (automations.length === 0) {
        void DialogAlert.show(dialog, "Automation", "No durable automations are configured in this workspace.")
        return
      }
      dialog.replace(() => (
        <DialogSelect
          title="Automation · Rust journal"
          options={automations.map((raw) => {
            const automation = raw as Record<string, unknown>
            const definition = automation.definition as Record<string, unknown>
            const summary = automation.active ? "active" : automation.pending ? "pending" : automation.retryPending ? "retry pending" : "idle"
            return {
              title: `${safeAutomationText(automation.automationID)} · v${safeAutomationText(automation.version)} · ${summary}`,
              value: automation,
              description: `${safeAutomationText(definition.actionCapabilityID)} · ${safeAutomationText(definition.scheduleExpression)} · ${definition.enabled === true ? "enabled" : "disabled"}`,
              details: ["Guarded invocation unavailable", `Occurrence history: ${String(automation.historyCount)}`],
            }
          })}
          onSelect={(option) => {
            const automation = option.value
            const automationID = String(automation.automationID)
            const version = String(automation.version)
            const actions: DialogSelectOption<string>[] = [
              { title: "Inspect current journal state", value: "inspect", description: "Refresh the committed definition and active occurrences from OwnerLog." },
              { title: "View latest occurrence history", value: "history", description: "Read the bounded latest-first OwnerLog projection." },
              { title: automation.definition.enabled === true ? "Disable automation" : "Enable automation", value: "toggle", description: "Revision-fenced journal update; does not invoke the action." },
              { title: "Edit definition", value: "edit", description: "Replace the versioned definition with validated JSON." },
            ]
            dialog.replace(() => <DialogSelect title={`Automation · ${automationID}`} options={actions} onSelect={(action) => {
              void (async () => {
                try {
                  const sessionID = automationSessionID()
                  const common = { directory: sdk.directory, workspace: project.workspace.current(), schemaVersion: 1 as const, sessionID, automationID, idempotencyKey: `automation_${randomUUID().replaceAll("-", "")}`, expectedVersion: version }
                  if (action.value === "inspect") {
                    const inspected = await sdk.client.experimental.automation.inspect({ directory: sdk.directory, workspace: project.workspace.current(), sessionID, automationID }, { throwOnError: true })
                    const value = inspected.data as Record<string, unknown>
                    const definition = value.definition as Record<string, unknown>
                    const lines = [
                      `Automation: ${safeAutomationText(value.automationID)}`,
                      `Version: ${safeAutomationText(value.version, 32)}`,
                      `Action: ${safeAutomationText(definition.actionCapabilityID)}`,
                      `Schedule: ${safeAutomationText(definition.scheduleExpression)}`,
                      `Timezone: ${safeAutomationText(definition.timezone, 128)}`,
                      `Enabled: ${String(definition.enabled)}`,
                      `Invocation: unavailable until Guarded action receipts are supported`,
                    ]
                    void DialogAlert.show(dialog, `Automation · ${automationID}`, lines.join("\n"))
                    return
                  }
                  if (action.value === "history") {
                    const history = await sdk.client.experimental.automation.history({ directory: sdk.directory, workspace: project.workspace.current(), sessionID, automationID, limit: "32" }, { throwOnError: true })
                    const rows = Array.isArray(history.data.history) ? history.data.history : []
                    const text = rows.length === 0 ? "No occurrences recorded." : rows.map((item) => {
                      const occurrence = item as Record<string, unknown>
                      return `${safeAutomationText(occurrence.scheduledAtMs)} · ${safeAutomationText(occurrence.status, 32)} · attempt ${safeAutomationText(occurrence.attempt, 8)} · ${safeAutomationText(occurrence.occurrenceID, 128)}`
                    }).join("\n")
                    void DialogAlert.show(dialog, `Automation history · ${automationID}`, text)
                    return
                  }
                  if (action.value === "toggle") {
                    const enabled = automation.definition.enabled !== true
                    const response = enabled
                      ? await sdk.client.experimental.automation.enable(common, { throwOnError: true })
                      : await sdk.client.experimental.automation.disable(common, { throwOnError: true })
                    const versionValue = ((response.data as Record<string, unknown>).automation as Record<string, unknown>).version
                    toast.show({ message: `Automation ${automationID} ${enabled ? "enabled" : "disabled"} · revision ${String(versionValue ?? "committed")}`, variant: "info" })
                    return
                  }
                  const definition = automation.definition as Record<string, unknown>
                  dialog.replace(() => <DialogPrompt
                    title={`Edit automation · ${automationID}`}
                    placeholder={JSON.stringify(definition)}
                    description={() => <text>Enter the complete versioned definition as JSON. Schedule remains opaque here; invocation stays disabled until Guarded action receipts are available.</text>}
                    onConfirm={(value) => {
                      void (async () => {
                        try {
                          const parsed = JSON.parse(value) as Record<string, unknown>
                          const result = await sdk.client.experimental.automation.update({ ...common, definition: parsed }, { throwOnError: true })
                          dialog.clear()
                          const versionValue = ((result.data as Record<string, unknown>).automation as Record<string, unknown>).version
                          toast.show({ message: `Automation ${automationID} updated · revision ${String(versionValue ?? "committed")}`, variant: "info" })
                        } catch (error) { toast.error(error) }
                      })()
                    }}
                  />)
                } catch (error) { toast.error(error) }
              })()
            }} />)
          }}
        />
      ))
    } catch (error) { toast.error(error) }
  }

  function openAutomationCreate() {
    dialog.replace(() => <DialogPrompt
      title="Create durable automation"
      placeholder='{"automationID":"automation_…","definition":{"actionCapabilityID":"...","actionVersion":1,"actionDigest":"blake3:…","scheduleExpression":"…","timezone":"UTC","enabled":false,"overlapPolicy":"SKIP","missedRunPolicy":"SKIP","retry":{"maxAttempts":1,"initialDelayMs":1000,"maxDelayMs":60000}}}'
      description={() => <text>Enter a bounded automationID and complete definition JSON. Schedule resolution and execution are Rust-owned. Guarded invocation is unavailable in V1, so creating this record cannot run its action.</text>}
      onConfirm={(value) => {
        void (async () => {
          try {
            if (new TextEncoder().encode(value).byteLength > 8 * 1024) throw new Error("Automation definition exceeds the 8 KiB limit")
            const parsed = JSON.parse(value) as Record<string, unknown>
            if (typeof parsed.automationID !== "string" || typeof parsed.definition !== "object" || parsed.definition === null || Array.isArray(parsed.definition)) throw new Error("Provide automationID and definition")
            const response = await sdk.client.experimental.automation.create({ directory: sdk.directory, workspace: project.workspace.current(), schemaVersion: 1, sessionID: automationSessionID(), automationID: parsed.automationID, idempotencyKey: `automation_${randomUUID().replaceAll("-", "")}`, definition: parsed.definition as Record<string, unknown> }, { throwOnError: true })
            dialog.clear()
            const versionValue = ((response.data as Record<string, unknown>).automation as Record<string, unknown>).version
            toast.show({ message: `Automation ${parsed.automationID} created · revision ${String(versionValue ?? "committed")}`, variant: "info" })
          } catch (error) { toast.error(error) }
        })()
      }}
    />)
  }

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("OpenCode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("OpenCode")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "…" : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      {
        name: "goal.review",
        title: "Review Goal proposal",
        category: "Session",
        slashName: "goal",
        run: openGoalReviewInbox,
      },
      {
        name: "goal.propose",
        title: "Propose a managed Goal",
        category: "Session",
        run: openGoalProposal,
      },
      {
        name: "goal.verify",
        title: "Verify an accepted managed Run",
        category: "Session",
        slashName: "goal-verify",
        run: openGoalVerification,
      },
      {
        name: "goal.control",
        title: "Pause, resume, or cancel a managed Run",
        category: "Session",
        slashName: "goal-control",
        run: openGoalRunControl,
      },
      {
        name: "goal.plan",
        title: "Plan tasks for an accepted Goal",
        category: "Session",
        slashName: "goal-plan",
        run: openGoalRunPlan,
      },
      {
        name: "goal.start",
        title: "Start a planned managed Run",
        category: "Session",
        slashName: "goal-start",
        run: openGoalRunStart,
      },
      {
        name: "automation.list",
        title: "Manage durable automations",
        category: "Session",
        slashName: "automations",
        run: openAutomationManager,
      },
      {
        name: "automation.create",
        title: "Create a durable automation definition",
        category: "Session",
        slashName: "automation-create",
        run: openAutomationCreate,
      },
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: async () => {
          const workspace = currentWorktreeWorkspace()
          if (!workspace?.directory) return
          await clipboard
            .write?.(workspace.directory)
            .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "workspace.list",
        title: "Manage workspaces",
        category: "Workspace",
        hidden: !Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "workspaces",
        run: () => {
          dialog.replace(() => <DialogWorkspaceList />)
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "model.list",
        title: "Switch model",
        suggested: true,
        category: "Agent",
        slashName: "models",
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slashAliases: ["mo"],
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: "Model cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: "Model cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: "Favorite cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: "Favorite cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "agent.list",
        title: "Switch agent",
        category: "Agent",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "mcp.list",
        title: "Toggle MCPs",
        category: "Agent",
        slashName: "mcps",
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "agent.cycle",
        title: "Agent cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: "Variant cycle",
        category: "Agent",
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: "Switch model variant",
        category: "Agent",
        hidden: local.model.variant.list().length === 0,
        slashName: "variants",
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: "No variants available",
              message: "The current model does not support any variants.",
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Agent cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(-1)
        },
      },
      {
        name: "provider.connect",
        title: "Connect provider",
        suggested: !connected(),
        slashName: "connect",
        run: () => {
          dialog.replace(() => <DialogProviderList />)
        },
        category: "Provider",
      },
      ...(sync.data.console_state.switchableOrgCount > 1
        ? [
            {
              name: "console.org.switch",
              title: "Switch org",
              suggested: Boolean(sync.data.console_state.activeOrgName),
              slashName: "org",
              slashAliases: ["orgs", "switch-org"],
              run: () => {
                dialog.replace(() => <DialogConsoleOrg />)
              },
              category: "Provider",
            },
          ]
        : []),
      {
        name: "horizon.settings.features",
        title: "Settings · Features / Experimental",
        category: "System",
        slashName: "features",
        run: () => {
          dialog.replace(() => <DialogFeatures />)
        },
      },
      {
        name: "web.search.settings",
        title: "Settings · Web search",
        category: "System",
        slashName: "web-search",
        run: () => {
          dialog.replace(() => <DialogWebSearchSettings />)
        },
      },
      {
        name: "provider.doctor.offline",
        title: "Settings · Provider Doctor · Offline",
        category: "System",
        slashName: "provider-doctor",
        run: () => {
          dialog.replace(() => <DialogProviderDoctor />)
        },
      },
      {
        name: "opencode.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      {
        name: "opencode.debug",
        title: "View debug info",
        slashName: "debug",
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: "System",
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          openUrl("https://opencode.ai/docs").catch(() => {})
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
      {
        name: "permission.mode",
        title:
          local.permission.mode === "auto" ? "Disable auto-approve permissions" : "Enable auto-approve permissions",
        category: "System",
        run: () => {
          local.permission.toggle()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    console.log("installation.update-available", evt)
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !isVersionGreater(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. Would you like to update now?`,
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: `Updating to v${version}…`,
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: "Update Failed",
        message: "Update failed",
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to OpenCode v${result.data.version}. Please restart the application.`,
    )

    void exit()
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={Flag.OPENCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={ready} />
      </Show>
    </box>
  )
}
