import { createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

export type AutomationDefinitionV1 = {
  actionCapabilityID: string
  actionVersion: number
  actionDigest: string
  actionSchemaDigest: string
  actionInputJSON: string
  scheduleExpression: string
  timezone: string
  enabled: boolean
  overlapPolicy: "SKIP" | "QUEUE_ONE"
  missedRunPolicy: "SKIP" | "RUN_LATEST" | "QUEUE_ONE"
  retry: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number }
}

const MAX_JSON_BYTES = 32 * 1024
const MAX_ACTION_INPUT_BYTES = 16 * 1024
const CAPABILITY_ID = /^[a-z][a-z0-9._-]{0,63}$/
const DIGEST = /^(sha256|blake3):[0-9a-f]{64}$/
const MAX_RETRY_MS = 30 * 24 * 60 * 60 * 1000

function parseDefinition(source: string): AutomationDefinitionV1 {
  if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES) throw new Error("Definition JSON exceeds 16 KiB.")
  const value: unknown = JSON.parse(source)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Definition must be a JSON object.")
  const input = value as Record<string, unknown>
  const fields = ["actionCapabilityID", "actionVersion", "actionDigest", "actionSchemaDigest", "actionInputJSON", "scheduleExpression", "timezone", "enabled", "overlapPolicy", "missedRunPolicy", "retry"]
  if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    throw new Error("Definition must contain exactly the documented fields.")
  }
  const retry = input.retry
  if (typeof retry !== "object" || retry === null || Array.isArray(retry)) throw new Error("retry must be an object.")
  const retryValue = retry as Record<string, unknown>
  if (Object.keys(retryValue).length !== 3 || !["maxAttempts", "initialDelayMs", "maxDelayMs"].every((key) => Object.hasOwn(retryValue, key))) {
    throw new Error("retry must contain exactly maxAttempts, initialDelayMs and maxDelayMs.")
  }
  const boundedText = (item: unknown, label: string, max: number) => {
    if (typeof item !== "string" || item.trim() !== item || !item || Buffer.byteLength(item, "utf8") > max || /[\u0000-\u001f\u007f]/.test(item)) {
      throw new Error(`${label} is invalid or exceeds ${max} bytes.`)
    }
    return item
  }
  const boundedInt = (item: unknown, label: string, min: number, max: number) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < min || item > max) throw new Error(`${label} is outside its allowed range.`)
    return item
  }
  const actionCapabilityID = boundedText(input.actionCapabilityID, "actionCapabilityID", 256)
  if (!CAPABILITY_ID.test(actionCapabilityID)) throw new Error("actionCapabilityID must be a canonical capability identifier.")
  const actionDigest = boundedText(input.actionDigest, "actionDigest", 71)
  if (!DIGEST.test(actionDigest)) throw new Error("actionDigest must be a SHA-256 or BLAKE3 digest.")
  const actionSchemaDigest = boundedText(input.actionSchemaDigest, "actionSchemaDigest", 71)
  if (!/^blake3:[0-9a-f]{64}$/.test(actionSchemaDigest)) throw new Error("actionSchemaDigest must be the canonical registry schema digest.")
  const actionInputJSON = boundedText(input.actionInputJSON, "actionInputJSON", MAX_ACTION_INPUT_BYTES)
  if (!canonicalActionInputJSON(actionInputJSON)) throw new Error("actionInputJSON must be a bounded canonical JSON object using safe integers.")
  if (input.overlapPolicy !== "SKIP" && input.overlapPolicy !== "QUEUE_ONE") throw new Error("overlapPolicy is invalid.")
  if (input.missedRunPolicy !== "SKIP" && input.missedRunPolicy !== "RUN_LATEST" && input.missedRunPolicy !== "QUEUE_ONE") {
    throw new Error("missedRunPolicy is invalid.")
  }
  const definition: AutomationDefinitionV1 = {
    actionCapabilityID,
    actionVersion: boundedInt(input.actionVersion, "actionVersion", 1, Number.MAX_SAFE_INTEGER),
    actionDigest,
    actionSchemaDigest,
    actionInputJSON,
    scheduleExpression: boundedText(input.scheduleExpression, "scheduleExpression", 512),
    timezone: boundedText(input.timezone, "timezone", 128),
    enabled: input.enabled === true,
    overlapPolicy: input.overlapPolicy,
    missedRunPolicy: input.missedRunPolicy,
    retry: {
      maxAttempts: boundedInt(retryValue.maxAttempts, "retry.maxAttempts", 1, 16),
      initialDelayMs: boundedInt(retryValue.initialDelayMs, "retry.initialDelayMs", 0, MAX_RETRY_MS),
      maxDelayMs: boundedInt(retryValue.maxDelayMs, "retry.maxDelayMs", 0, MAX_RETRY_MS),
    },
  }
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean.")
  if (definition.retry.initialDelayMs > definition.retry.maxDelayMs) throw new Error("retry.initialDelayMs cannot exceed maxDelayMs.")
  return definition
}

function canonicalActionInputJSON(source: string): boolean {
  try {
    const parsed: unknown = JSON.parse(source)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
    let nodes = 0
    const canonical = (value: unknown, depth: number): string => {
      nodes += 1
      if (nodes > 2_048 || depth > 16) throw new Error("input bound exceeded")
      if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("input number must be a safe integer")
        return String(value)
      }
      if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`
      if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.some(([key]) => !/^[\x20-\x7e]*$/.test(key))) throw new Error("input keys must be ASCII")
        entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(",")}}`
      }
      throw new Error("unsupported input value")
    }
    return Buffer.byteLength(source, "utf8") <= MAX_ACTION_INPUT_BYTES && canonical(parsed, 1) === source
  } catch {
    return false
  }
}

export function DialogAutomationDefinition(props: {
  automationID: string
  expectedVersion?: string
  initial?: AutomationDefinitionV1
  onSave: (definition: AutomationDefinitionV1) => Promise<void>
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [source, setSource] = createSignal(JSON.stringify(props.initial ?? {
    actionCapabilityID: "",
    actionVersion: 1,
    actionDigest: "sha256:<64 lowercase hex characters>",
    actionSchemaDigest: "blake3:<64 lowercase hex characters>",
    actionInputJSON: "{}",
    scheduleExpression: "",
    timezone: "UTC",
    enabled: false,
    overlapPolicy: "SKIP",
    missedRunPolicy: "SKIP",
    retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
  }, null, 2))
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let editor: TextareaRenderable | undefined

  async function save() {
    if (busy()) return
    setError("")
    let definition: AutomationDefinitionV1
    try {
      definition = parseDefinition(source())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Definition JSON is invalid.")
      return
    }
    setBusy(true)
    try {
      await props.onSave(definition)
      dialog.clear()
    } catch {
      setError("Guarded save was not confirmed. Inspect the automation journal before starting another action.")
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text}>Automation definition · {props.automationID}{props.expectedVersion ? ` · version ${props.expectedVersion}` : " · new"}</text>
      <text fg={theme.textMuted}>Bind a registered action version and schema digest to one fixed canonical JSON input object. Saving asks Guard for approval; it does not invoke the schedule.</text>
      <textarea
        ref={(input: TextareaRenderable) => {
          editor = input
          queueMicrotask(() => input.focus())
        }}
        initialValue={source()}
        placeholder="Automation definition JSON"
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        minHeight={8}
        maxHeight={24}
        onContentChange={() => setSource(editor?.plainText ?? "")}
        onSubmit={() => void save()}
      />
      {error() && <text fg={theme.error}>{error()}</text>}
      <text fg={theme.textMuted}>{busy() ? "Waiting for Guarded mutation receipt…" : "Submit to request one Guard approval · Escape to cancel"}</text>
    </box>
  )
}
