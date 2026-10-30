import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { RepoExplorerDiscoveryV1, RepoExplorerDocumentV1, RepoExplorerEntryV1 } from "@horizoncode/sdk/v2"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { boundToolOutput, redactToolText } from "../util/collapse-tool-output"

const MAX_FILE_BYTES = 131_072
const MAX_PREVIEW_CHARS = 16_384
const MAX_DISCOVERY_BYTES = 262_144
const SENSITIVE_ENTRY_LABEL = /(?:^|[._-])(?:env|credentials?|secrets?|passwords?|tokens?|private[-_]?key|id_rsa|id_ed25519)(?:$|[._-])|\.(?:pem|p12|pfx|key)$/i

type ExplorerRow = { readonly kind: "parent" } | { readonly kind: "entry"; readonly entry: RepoExplorerEntryV1 }

const cleanTerminalText = (value: string) => value
  .replace(/\u001b/g, "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, "")
const displayPath = (value: string) => cleanTerminalText(value).replace(/[\n\t]/g, " ")

function parentDirectory(path: string) {
  if (path === ".") return "."
  const index = path.lastIndexOf("/")
  return index < 0 ? "." : path.slice(0, index) || "."
}

function basename(path: string) {
  return path.split("/").at(-1) ?? path
}

function displayPathRef(path: string) {
  return path.split("/").map((part) => {
    if (SENSITIVE_ENTRY_LABEL.test(part)) return "[credential-like]"
    return displayPath(redactToolText(part))
  }).join("/")
}

function displayEntryName(path: string) {
  return displayPathRef(basename(path))
}

function pathDepthFromRoot(pathRef: string, rootRef: string) {
  const root = rootRef === "." ? [] : rootRef.split("/")
  const path = pathRef.split("/")
  if (path.length <= root.length || root.some((part, index) => path[index] !== part)) return undefined
  return path.length - root.length
}

function compareUtf8(left: string, right: string) {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function previewText(document: RepoExplorerDocumentV1) {
  return boundToolOutput(cleanTerminalText(document.text), MAX_PREVIEW_CHARS, 1).output
}

function DialogEditorFilePreview(props: {
  pathRef: string
  sourceRevision: string
  onOpenFile?: (pathRef: string, sourceRevision: string, contentDigest: string) => void
}) {
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [document, setDocument] = createSignal<RepoExplorerDocumentV1>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    if (!sessionID) {
      setError("Explorer requires an active Session")
      setLoading(false)
      return
    }
    void sdk.client.experimental.repoExplorer.read({ sessionID, pathRef: props.pathRef, sourceRevision: props.sourceRevision }, { throwOnError: true }).then((result) => {
      // The generated client's RequestResult maps multi-field DTOs to a union
      // of their property values. The authenticated route returns the exact
      // document; decode the validated envelope below.
      const value = result.data as unknown as RepoExplorerDocumentV1
      if (value.status !== "OK" || value.pathRef !== props.pathRef || value.revisionKind !== "discovery_observation" ||
          value.schemaVersion !== 1 || value.observedWorkspaceRevision !== props.sourceRevision ||
          !/^blake3:[0-9a-f]{64}$/.test(value.contentDigest) || Buffer.byteLength(value.text, "utf8") > MAX_FILE_BYTES) {
        throw new Error("HostKernel returned a stale or oversized document")
      }
      setDocument(value)
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => setLoading(false))
  })

  return (
    <box flexDirection="column" paddingX={2} paddingBottom={1} gap={1}>
      <text fg={theme.text}>Preview: {displayPathRef(props.pathRef)}</text>
      <Show when={loading()}><text fg={theme.textMuted}>Reading exact discovery revision…</text></Show>
      <Show when={error()}><text fg={theme.error}>Read unavailable: {error()}</text></Show>
      <Show when={document()}>
        {(value) => <text fg={theme.text}>{previewText(value())}</text>}
      </Show>
      <Show when={props.onOpenFile && document()}>
        <DialogSelect<"open">
          title="Open this file"
          options={[{ title: "Open in configured editor", value: "open" }]}
          onSelect={() => {
            if (!document() || !props.onOpenFile) return
            props.onOpenFile(props.pathRef, props.sourceRevision, document()!.contentDigest)
            dialog.closeTop()
          }}
        />
      </Show>
      <text fg={theme.textMuted}>Read-only preview. The file was opened through authenticated HostKernel document read.</text>
      <text fg={theme.textMuted}>Press Escape to return to Explorer.</text>
    </box>
  )
}

function useExplorer() {
  const sdk = useSDK()
  const route = useRoute()
  const [path, setPath] = createSignal(".")
  const [page, setPage] = createSignal<RepoExplorerDiscoveryV1>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()

  async function load(rootRef = path()) {
    setPath(rootRef)
    setLoading(true)
    setError(undefined)
    try {
      const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
      if (!sessionID) throw new Error("Explorer requires an active Session")
      const result = await sdk.client.experimental.repoExplorer.discover({ sessionID, rootRef, maxDepth: 2 }, { throwOnError: true })
      // See the document-read note: unwrap the generated union type to the
      // exact route DTO before the strict runtime validation below.
      const value = result.data as unknown as RepoExplorerDiscoveryV1
      const entriesValid = value.entries.every((entry, index) => {
        const depth = pathDepthFromRoot(entry.pathRef, rootRef)
        const pathSegments = entry.pathRef.split("/")
        const normalizedPath = !entry.pathRef.startsWith("/") && !entry.pathRef.includes("\\") && !entry.pathRef.includes(":") &&
          pathSegments.every((part) => part.length > 0 && part !== "." && part !== "..")
        const sizeIsU64 = /^(0|[1-9][0-9]{0,19})$/.test(entry.sizeBytes) && BigInt(entry.sizeBytes) <= 18_446_744_073_709_551_615n
        return depth !== undefined && depth === entry.depth && depth <= 2 &&
          normalizedPath && sizeIsU64 && ["file", "directory", "symlink", "other"].includes(entry.kind) &&
          (index === 0 || compareUtf8(value.entries[index - 1].pathRef, entry.pathRef) < 0)
      })
      if (value.schemaVersion !== 1 || value.messageType !== "discovery" ||
          !["CURRENT", "PARTIAL", "UNAVAILABLE"].includes(value.status) ||
          !["current", "unknown"].includes(value.freshness) ||
          value.authority.sessionID !== sessionID ||
          value.authority.rootRef !== rootRef || value.authority.mode !== "tree" ||
          value.authority.maxEntries !== 256 || value.authority.maxBytes !== MAX_DISCOVERY_BYTES || value.authority.maxDepth !== 2 ||
          !/^blake3:[0-9a-f]{64}$/.test(value.authority.sourceRevision) ||
          value.coverage.entries !== value.entries.length || value.entries.length > 256 ||
          value.coverage.bytes > value.authority.maxBytes || value.coverage.depth > value.authority.maxDepth ||
          (value.status === "CURRENT" && value.completeness !== "complete") ||
          (value.status === "PARTIAL" && value.completeness !== "partial") ||
          (value.status === "UNAVAILABLE" && (value.completeness !== "unavailable" || value.entries.length !== 0)) || !entriesValid) {
        throw new Error("HostKernel discovery response failed identity or bounds validation")
      }
      setPage(value)
      if (value.status === "UNAVAILABLE") setError(`HostKernel reports ${value.unavailableReason ?? "read unavailable"}`)
      else if (value.status === "PARTIAL") setError(`Partial inventory: ${value.partialReason ?? "bounded result"}`)
    } catch (cause) {
      setPage(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load("."))
  return { path, page, loading, error, load }
}

export function DialogEditorExplorer(props: {
  onOpenFile?: (pathRef: string, sourceRevision: string, contentDigest: string) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const explorer = useExplorer()

  const options = createMemo<DialogSelectOption<ExplorerRow>[]>(() => {
    const current = explorer.path()
    const rows: DialogSelectOption<ExplorerRow>[] = []
    if (current !== ".") rows.push({ title: "..", value: { kind: "parent" }, category: "Navigation" })
    for (const entry of explorer.page()?.entries ?? []) {
      const suffix = entry.kind === "directory" ? "/" : entry.kind === "symlink" ? " [symlink: not followed]" : entry.kind === "other" ? " [unsupported]" : ""
      const tooLarge = entry.kind === "file" && BigInt(entry.sizeBytes) > BigInt(MAX_FILE_BYTES)
      rows.push({
        title: `${displayEntryName(entry.pathRef)}${suffix}`,
        value: { kind: "entry", entry },
        category: entry.kind === "directory" ? "Directories" : "Files",
        footer: tooLarge ? "Too large for bounded preview" : entry.languageHint,
        disabled: entry.kind === "symlink" || entry.kind === "other" || tooLarge,
      })
    }
    return rows
  })

  return (
    <box flexDirection="column">
      <Show when={explorer.error()}><text fg={theme.warning}>{explorer.error()}</text></Show>
      <DialogSelect
        title={`Workspace Explorer · ${displayPathRef(explorer.path())}`}
        placeholder="Filter files and directories"
        options={options()}
        emptyView={
          <box flexDirection="column" paddingX={2} paddingY={1}>
            <Show when={explorer.loading()} fallback={<text fg={theme.textMuted}>{explorer.error() ?? "No entries in this directory."}</text>}>
              <text fg={theme.textMuted}>Loading authenticated HostKernel inventory…</text>
            </Show>
          </box>
        }
        footerHints={[{ title: "Open directory or preview file", label: "Enter" }]}
        onSelect={(option) => {
          const row = option.value
          if (row.kind === "parent") {
            void explorer.load(parentDirectory(explorer.path()))
            return
          }
          if (row.entry.kind === "directory") {
            void explorer.load(row.entry.pathRef)
            return
          }
          if (row.entry.kind !== "file") return
          const revision = explorer.page()?.authority.sourceRevision
          if (!revision) return
          dialog.push(<DialogEditorFilePreview pathRef={row.entry.pathRef} sourceRevision={revision} onOpenFile={props.onOpenFile} />)
        }}
      />
    </box>
  )
}

export function EditorExplorerPane(props: {
  onClose: () => void
  onOpenFile?: (pathRef: string, sourceRevision: string, contentDigest: string) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const explorer = useExplorer()
  const options = createMemo<DialogSelectOption<ExplorerRow>[]>(() => {
    const rows: DialogSelectOption<ExplorerRow>[] = []
    if (explorer.path() !== ".") rows.push({ title: "..", value: { kind: "parent" }, category: "Navigation" })
    for (const entry of explorer.page()?.entries ?? []) {
      const suffix = entry.kind === "directory" ? "/" : entry.kind === "symlink" ? " [symlink: not followed]" : entry.kind === "other" ? " [unsupported]" : ""
      const tooLarge = entry.kind === "file" && BigInt(entry.sizeBytes) > BigInt(MAX_FILE_BYTES)
      rows.push({
        title: `${"  ".repeat(Math.min(entry.depth, 8))}${displayEntryName(entry.pathRef)}${suffix}`,
        value: { kind: "entry", entry },
        category: entry.kind === "directory" ? "Directories" : "Files",
        footer: tooLarge ? "Too large for bounded preview" : entry.languageHint,
        disabled: entry.kind === "symlink" || entry.kind === "other" || tooLarge,
      })
    }
    return rows
  })
  return (
    <box flexDirection="column" width={42} height="100%" border borderColor={theme.border} paddingX={1}>
      <text fg={theme.text}>Workspace Explorer</text>
      <text fg={theme.textMuted}>{displayPathRef(explorer.path())} · {explorer.page()?.coverage.entries ?? 0} entries</text>
      <Show when={explorer.error()}><text fg={theme.warning}>{explorer.error()}</text></Show>
      <DialogSelect
        title="Workspace Explorer"
        options={options()}
        emptyView={<text fg={theme.textMuted}>{explorer.loading() ? "Loading…" : "No entries"}</text>}
        onSelect={(option) => {
          const row = option.value
          if (row.kind === "parent") {
            void explorer.load(parentDirectory(explorer.path()))
            return
          }
          if (row.entry.kind === "directory") {
            void explorer.load(row.entry.pathRef)
            return
          }
          if (row.entry.kind === "file") {
            const revision = explorer.page()?.authority.sourceRevision
            if (revision) dialog.push(<DialogEditorFilePreview pathRef={row.entry.pathRef} sourceRevision={revision} onOpenFile={props.onOpenFile} />)
          }
        }}
        actions={[{ command: "session.editor.close", title: "Close Explorer", onTrigger: props.onClose }]}
      />
    </box>
  )
}
