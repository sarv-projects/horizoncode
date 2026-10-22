import { createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"

const MAX_DRAFT_BYTES = 32 * 1024

const INITIAL_DRAFT = JSON.stringify({
  schemaVersion: 1,
  objective: "Describe the requested outcome",
  capabilityScope: [],
  scope: ["Repository area or boundaries"],
  constraints: [],
  criteria: [{ id: "criterion-1", description: "Observable acceptance condition" }],
  budget: {
    maxTasks: 1,
    maxAttemptsPerTask: 1,
    maxRunDurationMs: 1800000,
    maxWorkers: 1,
  },
  sourceDigests: [],
}, null, 2)

/** Create a user-authored proposal. Rust assigns proposer identity and workspace authority. */
export function DialogGoalProposal(props: { directory?: string; workspace?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [source, setSource] = createSignal(INITIAL_DRAFT)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let editor: TextareaRenderable | undefined

  async function submit() {
    if (busy()) return
    setError("")
    if (Buffer.byteLength(source(), "utf8") > MAX_DRAFT_BYTES) {
      setError("Proposal draft exceeds 32 KiB.")
      return
    }
    let draft: unknown
    try {
      draft = JSON.parse(source())
      if (typeof draft !== "object" || draft === null || Array.isArray(draft)) throw new Error()
    } catch {
      setError("Enter one JSON object matching the displayed GoalProposalDraftV1 fields.")
      return
    }
    setBusy(true)
    try {
      const response = await sdk.client.experimental.goalReview.goalPropose({
        ...(draft as Parameters<typeof sdk.client.experimental.goalReview.goalPropose>[0]),
        directory: props.directory,
        workspace: props.workspace,
      }, { throwOnError: true })
      dialog.clear()
      toast.show({
        message: `Goal proposal ${response.data.goalID} created at ${response.data.specDigest}. It requires a distinct authenticated reviewer.`,
        variant: "success",
        duration: 8000,
      })
    } catch {
      setError("The authenticated Core owner did not confirm this proposal. Review the workspace and draft before submitting again.")
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>Propose a managed Goal</text>
      <text fg={theme.textMuted}>Edit this bounded JSON draft. The server derives proposer identity and workspace; creation does not accept the SpecVersion or start a Run. A distinct authenticated reviewer must accept its exact digest.</text>
      <textarea
        ref={(input: TextareaRenderable) => {
          editor = input
          queueMicrotask(() => input.focus())
        }}
        initialValue={source()}
        placeholder="GoalProposalDraftV1 JSON"
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        minHeight={10}
        maxHeight={28}
        onContentChange={() => setSource(editor?.plainText ?? "")}
        onSubmit={() => void submit()}
      />
      {error() && <text fg={theme.error}>{error()}</text>}
      <text fg={theme.textMuted}>{busy() ? "Saving proposal in Rust managed control…" : "Submit creates a pending proposal only · Escape cancels"}</text>
    </box>
  )
}
