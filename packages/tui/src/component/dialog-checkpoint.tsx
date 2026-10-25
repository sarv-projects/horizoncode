import { createSignal, For, onMount, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { Dialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { boundToolOutput } from "../util/collapse-tool-output"

type CheckpointConflict = {
  readonly path?: string
  readonly kind: string
}

type CheckpointPreview = {
  readonly checkpointID: string
  readonly checkpointArtifact: { readonly digest: string; readonly byteLength: string }
  readonly workspaceRevision: string
  readonly workspaceRevisionChanged: boolean
  readonly mode: "FULL" | "SELECTED_PATHS"
  readonly selectedPaths: readonly string[]
  readonly actions: readonly { readonly path: string }[]
  readonly conflicts: readonly CheckpointConflict[]
  readonly previewDigest: string
}

const ID = /^[A-Za-z0-9._-]{1,256}$/
const DIGEST = /^blake3:[0-9a-f]{64}$/
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const CONFLICTS = new Set([
  "WORKSPACE_REVISION_CHANGED",
  "DIRTY_PATH",
  "UNTRACKED_PATH",
  "WORKSPACE_STATUS_UNAVAILABLE",
  "UNSAFE_PATH",
])

/** Sanitize untrusted checkpoint metadata for terminal display without changing authority values. */
export function safeCheckpointDisplayText(value: string, maxBytes: number) {
  return boundToolOutput(value.replace(/[\r\n\t]/g, " "), maxBytes, 1).output
}

function safeRelativePath(path: string) {
  return !/^[\\/]/.test(path) && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

export function decodeCheckpointPreview(input: unknown): CheckpointPreview {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Preview response is malformed.")
  const value = input as Record<string, unknown>
  const artifact = value.checkpointArtifact
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("Preview artifact is unavailable.")
  const metadata = artifact as Record<string, unknown>
  if (
    typeof value.checkpointID !== "string" || !ID.test(value.checkpointID) ||
    typeof metadata.artifactID !== "string" || !ID.test(metadata.artifactID) ||
    typeof metadata.digest !== "string" || !DIGEST.test(metadata.digest) ||
    typeof metadata.byteLength !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(metadata.byteLength) || BigInt(metadata.byteLength) > MAX_U64 ||
    typeof metadata.mediaType !== "string" || !metadata.mediaType || metadata.mediaType.length > 256 ||
    !["public", "workspace", "sensitive"].includes(String(metadata.classification)) ||
    typeof value.workspaceRevision !== "string" || !DIGEST.test(value.workspaceRevision) ||
    typeof value.workspaceRevisionChanged !== "boolean" ||
    (value.mode !== "FULL" && value.mode !== "SELECTED_PATHS") ||
    !Array.isArray(value.selectedPaths) || value.selectedPaths.length > 2_048 ||
    !Array.isArray(value.actions) || value.actions.length > 2_048 ||
    !Array.isArray(value.conflicts) || value.conflicts.length > 2_048 ||
    typeof value.previewDigest !== "string" || !DIGEST.test(value.previewDigest)
  ) throw new Error("Preview response failed validation.")
  const conflicts = value.conflicts.map((item): CheckpointConflict => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Preview conflict is malformed.")
    const conflict = item as Record<string, unknown>
    if (typeof conflict.kind !== "string" || !CONFLICTS.has(conflict.kind) ||
        !(conflict.path === null || conflict.path === undefined || typeof conflict.path === "string" && conflict.path.length <= 4_096)) {
      throw new Error("Preview conflict is malformed.")
    }
    if (typeof conflict.path === "string" && !safeRelativePath(conflict.path)) throw new Error("Preview conflict path is unsafe.")
    return { kind: conflict.kind, ...(typeof conflict.path === "string" ? { path: conflict.path } : {}) }
  })
  const actions = value.actions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Preview action is malformed.")
    }
    const action = item as Record<string, unknown>
    const target = action.target
    if (Object.keys(action).toSorted().join("\0") !== ["path", "expectedBeforeDigest", "target"].sort().join("\0") ||
        typeof action.path !== "string" ||
        !(action.expectedBeforeDigest === null || typeof action.expectedBeforeDigest === "string" && DIGEST.test(action.expectedBeforeDigest)) ||
        !target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("Preview action is malformed.")
    }
    const targetRecord = target as Record<string, unknown>
    if (Object.keys(targetRecord).toSorted().join("\0") !== ["kind", "digest", "byteLength", "executable", "linkCount"].sort().join("\0") ||
        targetRecord.kind !== "REGULAR_FILE" || typeof targetRecord.digest !== "string" || !DIGEST.test(targetRecord.digest) ||
        typeof targetRecord.byteLength !== "number" || !Number.isSafeInteger(targetRecord.byteLength) || targetRecord.byteLength < 0 ||
        typeof targetRecord.executable !== "boolean" || targetRecord.linkCount !== 1) {
      throw new Error("Preview action target is not a regular single-link file.")
    }
    const path = action.path
    if (!path || path.length > 4_096 || !safeRelativePath(path)) throw new Error("Preview action path is invalid.")
    return { path }
  })
  const selectedPaths = value.selectedPaths.map((path) => {
    if (typeof path !== "string" || !path || path.length > 4_096 || !safeRelativePath(path)) throw new Error("Preview selection is malformed.")
    return path
  })
  if (new Set(selectedPaths).size !== selectedPaths.length ||
      new Set(actions.map((action) => action.path)).size !== actions.length ||
      value.mode === "SELECTED_PATHS" && actions.some((action) => !selectedPaths.includes(action.path)) ||
      value.mode === "FULL" && selectedPaths.length !== 0 ||
      value.mode === "SELECTED_PATHS" && selectedPaths.length === 0 ||
      conflicts.length > 0 && actions.length > 0) throw new Error("Preview response is inconsistent.")
  return {
    checkpointID: value.checkpointID,
    checkpointArtifact: { digest: metadata.digest, byteLength: metadata.byteLength },
    workspaceRevision: value.workspaceRevision,
    workspaceRevisionChanged: value.workspaceRevisionChanged,
    mode: value.mode,
    selectedPaths,
    actions,
    conflicts,
    previewDigest: value.previewDigest,
  }
}

function CheckpointPreviewDialog(props: { preview: CheckpointPreview }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const preview = () => props.preview
  const conflicts = () => preview().conflicts.slice(0, 24)
  return (
    <Dialog size="large" onClose={() => dialog.closeTop()}>
      <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
        <text fg={theme.text}>Checkpoint restore preview · read only</text>
        <text fg={theme.textMuted}>{`Checkpoint ${safeCheckpointDisplayText(preview().checkpointID, 256)} · ${preview().mode}`}</text>
        <text fg={theme.textMuted}>{`Artifact ${safeCheckpointDisplayText(preview().checkpointArtifact.digest, 80)} · ${safeCheckpointDisplayText(preview().checkpointArtifact.byteLength, 20)} bytes`}</text>
        <text fg={theme.textMuted}>{`Current workspace revision ${safeCheckpointDisplayText(preview().workspaceRevision, 80)}${preview().workspaceRevisionChanged ? " · changed since capture" : ""}`}</text>
        <text fg={theme.textMuted}>{`Preview digest ${safeCheckpointDisplayText(preview().previewDigest, 80)}`}</text>
        <text fg={preview().conflicts.length > 0 ? theme.warning : theme.textMuted}>
          {preview().conflicts.length > 0
            ? `Restore refused: ${preview().conflicts.length} conflict(s).`
            : `${preview().actions.length} planned path action(s); this preview does not authorize restore.`}
        </text>
        <For each={conflicts()}>{(conflict) => <text fg={theme.warning}>{`${safeCheckpointDisplayText(conflict.kind, 64)}${conflict.path ? ` · ${safeCheckpointDisplayText(conflict.path, 512)}` : ""}`}</text>}</For>
        <Show when={preview().conflicts.length > conflicts().length}>
          <text fg={theme.textMuted}>{`${preview().conflicts.length - conflicts().length} additional conflicts omitted`}</text>
        </Show>
        <text fg={theme.textMuted}>Capture and restore are unavailable until Guarded HostKernel effects and same-revision VCS evidence pass acceptance.</text>
        <text fg={theme.textMuted}>Esc closes this preview.</text>
      </box>
    </Dialog>
  )
}

export function DialogCheckpoint(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [checkpointIDs, setCheckpointIDs] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  onMount(() => {
    void sdk.client.experimental.checkpoint.list({ sessionID: props.sessionID }, { throwOnError: true })
      .then((response) => {
        // The generated client unwraps the single-property envelope to the
        // property value in its return type; the wire body is still
        // `{ checkpointIDs }`. Validate the documented envelope explicitly.
        const body = response.data as unknown
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Checkpoint list response failed validation.")
        const ids = (body as { checkpointIDs?: unknown }).checkpointIDs
        if (!Array.isArray(ids) || ids.length > 32 || ids.some((id) => typeof id !== "string" || !ID.test(id))) {
          throw new Error("Checkpoint list response failed validation.")
        }
        setCheckpointIDs(ids)
      })
      .catch(() => setError("Checkpoint list is unavailable from the authenticated runtime."))
      .finally(() => setLoading(false))
  })

  async function preview(checkpointID: string) {
    if (busy()) return
    setBusy(true)
    try {
      const response = await sdk.client.experimental.checkpoint.restorePreview({
        sessionID: props.sessionID,
        checkpointID,
        mode: "FULL",
        selectedPaths: [],
      }, { throwOnError: true })
      const decoded = decodeCheckpointPreview(response.data)
      if (decoded.checkpointID !== checkpointID || decoded.mode !== "FULL" || decoded.selectedPaths.length !== 0) {
        throw new Error("Preview does not match the selected checkpoint.")
      }
      dialog.push(<CheckpointPreviewDialog preview={decoded} />)
    } catch {
      toast.show({ message: "Checkpoint preview is unavailable; no restore action was attempted.", variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={<box paddingLeft={2} paddingRight={2}><text>Loading authenticated checkpoint list…</text></box>}
    >
      <Show when={!error()} fallback={<box paddingLeft={2} paddingRight={2}><text>{error()}</text></box>}>
        <Show
          when={checkpointIDs().length > 0}
          fallback={<box paddingLeft={2} paddingRight={2} gap={1}><text>No checkpoints are available for this Session.</text><text>Capture remains unavailable until Guarded HostKernel effects pass acceptance.</text></box>}
        >
          <DialogSelect
            title="Checkpoints · read-only"
            options={checkpointIDs().map((checkpointID) => ({
              title: safeCheckpointDisplayText(checkpointID, 256),
              value: checkpointID,
              description: busy() ? "Loading preview…" : "Inspect a digest-bound restore preview. Restore stays unavailable.",
              disabled: busy(),
            }))}
            onSelect={(option) => void preview(option.value)}
          />
        </Show>
      </Show>
    </Show>
  )
}
