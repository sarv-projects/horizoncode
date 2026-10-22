import { createMemo, createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { randomUUID } from "node:crypto"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

const MAX_GOAL_ID_BYTES = 256

/**
 * Selects facts from the authenticated Goal snapshot and Core-owned immutable
 * profile projection. Core resolves the full profile; Rust validates and pins
 * it. PLAN_ONLY stays non-dispatchable until the separate goal.start action.
 */
export function DialogGoalRunPlan(props: { directory?: string; workspace?: string; sessionID: string }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const [goalIDText, setGoalIDText] = createSignal("")
  const [snapshot, setSnapshot] = createSignal<Awaited<ReturnType<typeof loadGoal>>>()
  const [specID, setSpecID] = createSignal<string>()
  const [plan, setPlan] = createSignal<{
    goalID: string
    runID: string
    specID: string
    specDigest: string
    revision: string
    taskIDs: string[]
    taskPins: Array<{
      taskID: string
      goalID: string
      runID: string
      runRevision: string
      specID: string
      specDigest: string
      profileID: string
      profileRevision: string
      profileDigest: string
      acceptedScopeDigest: string
      profilePermissionCeilingDigest: string
    }>
  }>()
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const idempotencyKey = `goal_start_${randomUUID().replaceAll("-", "")}`
  let editor: TextareaRenderable | undefined

  async function loadGoal(id: string) {
    const response = await sdk.client.experimental.goalReview.goalReview(
      { goalID: id, directory: props.directory, workspace: props.workspace },
      { throwOnError: true },
    )
    return response.data
  }

  async function fetchGoal() {
    if (busy() || loaded()) return
    setError("")
    const goalID = goalIDText().trim()
    if (!goalID || Buffer.byteLength(goalID, "utf8") > MAX_GOAL_ID_BYTES || !/^[A-Za-z0-9._-]{1,256}$/.test(goalID)) {
      setError("Enter a Goal ID containing 1–256 letters, numbers, dots, underscores or hyphens.")
      return
    }
    setBusy(true)
    try {
      const value = await loadGoal(goalID)
      setSnapshot(value)
      setLoaded(true)
      if (value.acceptedSpecs.length === 0) setError("This Goal has no accepted SpecVersion available for a Run.")
    } catch {
      setError("The authenticated Goal snapshot is unavailable in this workspace.")
    } finally {
      setBusy(false)
    }
  }

  const acceptedSpecs = createMemo(() => snapshot()?.acceptedSpecs ?? [])
  const candidates = createMemo(() => snapshot()?.eligibleProfiles ?? [])
  const selectedSpec = createMemo(() => acceptedSpecs().find((item) => item.specID === specID()))
  const compatibleCandidates = createMemo(() => {
    const spec = selectedSpec()
    if (!spec) return []
    return candidates().filter((profile) => spec.capabilityScope.every((capability) => profile.capabilityCeiling.includes(capability)))
  })
  const profileOptions = createMemo(() => compatibleCandidates().map((profile) => ({
    title: profile.name,
    value: `${profile.profileId}@${profile.revision}`,
    category: `AgentProfile ${profile.profileId} · r${profile.revision}`,
    description: `Role ${profile.roles.join(", ")} · capability ceiling ${profile.capabilityCeiling.join(", ") || "empty"} · token budget ${profile.tokenBudget}`,
    footer: "Trusted Core Config candidate. Definition digest and effective plan pins are minted by Rust.",
  })))

  async function persistPlan(selectedProfileKey: string) {
    const current = snapshot()
    const spec = selectedSpec()
    const profile = compatibleCandidates().find((item) => `${item.profileId}@${item.revision}` === selectedProfileKey)
    if (!current || !spec || !profile || busy() || plan()) return
    setError("")
    const runID = `run_${randomUUID().replaceAll("-", "")}`
    const taskCount = Math.min(spec.criteria.length, spec.budget.maxTasks)
    const taskGroups = Array.from({ length: taskCount }, (_, index) =>
      spec.criteria.filter((_criterion, criterionIndex) => criterionIndex % taskCount === index),
    )
    // Never weaken an accepted Spec to fit a smaller profile ceiling. Keep the
    // whole requirement and let Rust validate the immutable profile authority.
    const requiredCapabilities = [...spec.capabilityScope].sort()
    if (!spec.criteria.length || spec.criteria.length > 32 || taskCount < 1 || spec.budget.maxTasks > 256) {
      setError("The accepted SpecVersion cannot fit the bounded V1 Task plan.")
      return
    }
    if (taskGroups.some((criteria) => Buffer.byteLength([spec.objective, ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`)].join("\n"), "utf8") > 8192)) {
      setError("An accepted criterion group exceeds the bounded Task purpose size.")
      return
    }
    const tasks = taskGroups.map((criteria, index) => {
      const taskID = `task_${randomUUID().replaceAll("-", "")}`
      const purpose = [spec.objective, ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`)].join("\n")
      return {
        taskID,
        title: taskCount === 1 ? "Implement accepted SpecVersion outcome" : `Implement accepted criteria group ${index + 1}`,
        purpose,
        // The TUI has no trusted file-conflict map yet, so serialize its
        // generated groups. Rust still accepts richer bounded DAGs from the
        // authenticated planning API; P8 owns conflict-safe worker leases.
        dependencies: [] as string[],
        criterionIDs: criteria.map((criterion) => criterion.id),
        requiredCapabilities,
        profileSelection: { profileId: profile.profileId, revision: profile.revision },
      }
    })
    for (let index = 1; index < tasks.length; index++) {
      tasks[index]!.dependencies = [tasks[index - 1]!.taskID]
    }
    setBusy(true)
    try {
      const response = await sdk.client.experimental.goalReview.goalRunPlan({
        directory: props.directory,
        workspace: props.workspace,
        schemaVersion: 1,
        goalID: current.goalID,
        specID: spec.specID,
        specDigest: spec.specDigest,
        expectedGoalRevision: current.goalRevision,
        runID,
        tasks,
      }, { throwOnError: true })
      const data = response.data
      if (data.status !== "PLAN_ONLY" || data.tasksReady || data.taskPins.length !== tasks.length ||
        data.goalID !== current.goalID || data.runID !== runID || data.specID !== spec.specID || data.specDigest !== spec.specDigest) {
        throw new Error("HostKernel did not return one immutable plan pin")
      }
      for (const [index, pin] of data.taskPins.entries()) {
        if (pin.taskID !== tasks[index]?.taskID || pin.goalID !== current.goalID || pin.runID !== runID ||
          pin.runRevision !== data.revision || pin.specID !== spec.specID || pin.specDigest !== spec.specDigest ||
          pin.profileID !== profile.profileId || pin.profileRevision !== profile.revision ||
          !pin.profileDigest.startsWith("blake3:") || !pin.acceptedScopeDigest.startsWith("blake3:") ||
          !pin.profilePermissionCeilingDigest.startsWith("blake3:")) {
          throw new Error("HostKernel Task pins do not match the selected accepted SpecVersion and trusted profile")
        }
      }
      setPlan(data)
    } catch {
      setError("Rust did not confirm PLAN_ONLY with matching immutable Task, SpecVersion and AgentProfile pins. Keep dispatch disabled and inspect the managed-control response.")
    } finally {
      setBusy(false)
    }
  }

  async function startRun() {
    const current = plan()
    if (busy() || !current || current.taskPins.length === 0) return
    setBusy(true)
    setError("")
    try {
      const response = await sdk.client.experimental.goalReview.goalRunStart({
        directory: props.directory,
        workspace: props.workspace,
        schemaVersion: 1,
        goalID: current.goalID,
        runID: current.runID,
        expectedGoalRevision: current.revision,
        specID: current.specID,
        specDigest: current.specDigest,
        sessionID: props.sessionID,
        idempotencyKey,
      }, { throwOnError: true })
      dialog.clear()
      toast.show({ message: `Run ${response.data.runID} started (${response.data.runPhase}). Task dispatch remains separately gated until runtime acceptance.`, variant: "info", duration: 8000 })
    } catch {
      setError(`goal.start was not confirmed. Keep this exact plan and idempotency key; inspect the Run before retrying. ${idempotencyKey}`)
    } finally {
      setBusy(false)
    }
  }

  if (plan()) {
    const current = plan()!
    const pin = current.taskPins[0]!
    return <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>PLAN_ONLY · managed Run</text>
      <text fg={theme.textMuted}>Goal {current.goalID} · Run {current.runID} · accepted SpecVersion {current.specID} · revision {current.revision}</text>
      <text fg={theme.textMuted}>Tasks ({current.taskPins.length}): {current.taskPins.map((task) => task.taskID).join(", ")}</text>
      <text fg={theme.textMuted}>AgentProfile {pin.profileID}@{pin.profileRevision} · Rust-pinned profile, accepted scope and permission ceiling digests are retained per Task.</text>
      <text fg={theme.textMuted}>These are PLAN_ONLY pins. The effective permission scope digest is minted later when HostKernel admits an authenticated Attempt.</text>
      {error() && <text fg={theme.error}>{error()}</text>}
      <DialogSelect title="Explicitly start this exact managed Run?" options={[{
        title: "Start this exact Run",
        value: "start" as const,
        description: `Run ${current.runID} · Spec ${current.specID} · Profile ${pin.profileID}@${pin.profileRevision}`,
        footer: `Idempotency key ${idempotencyKey}`,
      }]} onSelect={() => void startRun()} />
      <text fg={theme.textMuted}>{busy() ? "Waiting for authenticated managed control…" : "Press Enter to call goal.start · Escape cancels"}</text>
    </box>
  }

  if (selectedSpec()) {
    const spec = selectedSpec()!
    if (compatibleCandidates().length === 0) {
      return <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
        <text fg={theme.text}>No compatible AgentProfileV2 candidates</text>
        <text fg={theme.textMuted}>{candidates().length === 0
          ? "Core found no enabled user-owned subagent profile with a positive token budget. Add one through trusted Core Config before planning."
          : "Available profiles do not cover every capability required by the accepted SpecVersion. Update the trusted profile ceiling or the reviewed SpecVersion before planning."}</text>
        {error() && <text fg={theme.error}>{error()}</text>}
      </box>
    }
    return <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>Choose a trusted AgentProfileV2</text>
      <text fg={theme.textMuted}>{spec.objective}</text>
      <text fg={theme.textMuted}>Criteria ({spec.criteria.length}): {spec.criteria.map((criterion) => criterion.id).join(", ")}</text>
      <text fg={theme.textMuted}>Scope: {spec.scope.slice(0, 8).join(" · ").slice(0, 512) || "none"}</text>
      <text fg={theme.textMuted}>Accepted capabilities: {spec.capabilityScope.join(", ") || "none"}</text>
      <text fg={theme.textMuted}>Constraints: {spec.constraints.slice(0, 8).join(" · ").slice(0, 512) || "none"}</text>
      <text fg={theme.textMuted}>Budget: {spec.budget.maxTasks} Tasks · {spec.budget.maxAttemptsPerTask} attempts/Task · {spec.budget.maxRunDurationMs} ms · {spec.budget.maxTokens ?? "no token ceiling"} tokens · {spec.budget.maxCostMicros ?? "no cost ceiling"} micros</text>
      {snapshot()?.eligibleProfilesTruncated && <text fg={theme.textMuted}>Only the first 128 trusted profiles are shown. Narrow Core Config or use an exact profile revision from the displayed candidates.</text>}
      {error() && <text fg={theme.error}>{error()}</text>}
      <DialogSelect title="AgentProfileV2 candidates" options={profileOptions()} onSelect={(option) => {
        void persistPlan(option.value)
      }} />
      <text fg={theme.textMuted}>{busy() ? "Persisting non-dispatchable PLAN_ONLY…" : "Select a profile to pin the plan"}</text>
    </box>
  }

  if (loaded()) {
    return <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>Choose the accepted SpecVersion</text>
      {error() && <text fg={theme.error}>{error()}</text>}
      <DialogSelect title="Accepted SpecVersions" options={acceptedSpecs().map((spec) => ({
        title: spec.objective,
        value: spec.specID,
        category: spec.specID,
        description: `${spec.criteria.length} criteria · ${spec.capabilityScope.length} capability scopes · max ${spec.budget.maxTasks} Tasks`,
        footer: spec.specDigest,
      }))} onSelect={(option) => setSpecID(option.value)} />
    </box>
  }

  return <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
    <text fg={theme.text}>Plan a managed Run from an accepted SpecVersion</text>
    <text fg={theme.textMuted}>Enter a Goal ID. Core will return its accepted criteria and eligible immutable profile references from trusted state. Rust pins the plan; execution remains unavailable until runtime gates pass.</text>
    <textarea
      ref={(input: TextareaRenderable) => {
        editor = input
        queueMicrotask(() => input.focus())
      }}
      initialValue={goalIDText()}
      placeholder="Goal ID"
      placeholderColor={theme.textMuted}
      textColor={theme.text}
      focusedTextColor={theme.text}
      cursorColor={theme.primary}
      minHeight={1}
      maxHeight={2}
      onContentChange={() => setGoalIDText(editor?.plainText ?? "")}
      onSubmit={() => void fetchGoal()}
    />
    {error() && <text fg={theme.error}>{error()}</text>}
    <text fg={theme.textMuted}>{busy() ? "Loading authenticated Goal snapshot…" : "Press Enter to load · Escape cancels"}</text>
  </box>
}
