/**
 * Classification helpers for command/tool telemetry emitted by the real
 * session event contract (packages/schema/src/session-event.ts).
 */

export type CommandClass = "test" | "patch" | "build" | "other"

const TEST_PATTERN =
  /\b(bun\s+test|npm\s+(run\s+)?test|npx\s+(jest|vitest|playwright|cypress)|yarn\s+test|pnpm\s+(run\s+)?test|pytest|py\.test|go\s+test|cargo\s+test|jest|vitest|phpunit|rspec|make\s+test|ctest|tox\b)/i

const PATCH_PATTERN = /\b(git\s+apply|git\s+am\b|patch\s+-p|git\s+format-patch|git\s+cherry-pick|git\s+rebase)\b/i

const BUILD_PATTERN = /\b(npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build|bun\s+run\s+build|tsc\b|cargo\s+build|go\s+build|make\b)/i

export function isTestCommand(command: string): boolean {
  return TEST_PATTERN.test(command)
}

export function classifyCommand(command: string): CommandClass {
  if (isTestCommand(command)) return "test"
  if (PATCH_PATTERN.test(command)) return "patch"
  if (BUILD_PATTERN.test(command)) return "build"
  return "other"
}

const SHELL_TOOLS = new Set(["bash", "shell", "terminal", "execute", "exec", "run_command", "run-command", "command"])
const FILE_MUTATING_TOOLS = /(^|_)(edit|write|multiedit|notebookedit|fileedit|apply_patch|patch|str_replace|create)(_|$)/i
const PATCH_TOOLS = /patch|apply|str_replace/i

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase())
}

export function isFileMutatingTool(name: string): boolean {
  return FILE_MUTATING_TOOLS.test(name)
}

export function isPatchTool(name: string): boolean {
  return PATCH_TOOLS.test(name)
}

/** Probe the real keys the shell tool emits for its exit code (see tool/shell.ts -> `exit`). */
export function extractExitCode(structured: unknown): number | null {
  if (structured === null || typeof structured !== "object") return null
  const record = structured as Record<string, unknown>
  for (const key of ["exit", "exitCode", "exit_code", "returnCode", "return_code", "code"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  }
  return null
}

const INVALID_ARGS_PATTERN =
  /invalid (tool )?argument|invalid (tool )?input|failed to parse (tool )?arguments?|malformed (tool )?arg|schema validation|does not match|unknown parameter|unexpected (property|argument)|missing required (field|parameter|argument)/i

export function isInvalidArgsMessage(message: string): boolean {
  return INVALID_ARGS_PATTERN.test(message)
}

const UNSAFE_DENIAL_PATTERN =
  /permission denied|not authorized|unauthorized|blocked by|requires approval|approval (required|denied)|policy violation|forbidden|operation not allowed|guard (denied|blocked)/i

export function isUnsafeDenialMessage(message: string): boolean {
  return UNSAFE_DENIAL_PATTERN.test(message)
}

const DESTRUCTIVE_PATTERN =
  /(\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b)|(\bmkfs\b)|(\bdd\s+if=)|(\b: \(\) \{)|(\bshutdown\b)|(\breboot\b)|(\bchmod\s+(-R\s+)?777\s+\/\s*$)|(\bkill\s+-9\s+-1\b)/i

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERN.test(command)
}

const CRASH_TIMEOUT_PATTERN =
  /\b(timeout|timed out|etimedout|deadline exceeded|crash|crashed|segfault|segmentation fault|sigkill|sigsegv|out of memory|oom|enomem|econnreset|econnrefused|econnaborted|socket hang up|network is unreachable|und_error|epipe)\b/i

export function isCrashTimeoutMessage(message: string): boolean {
  return CRASH_TIMEOUT_PATTERN.test(message)
}

/** Stable JSON key so identical tool inputs compare equal regardless of key order. */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((v) => stableKey(v)).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(record[k])}`).join(",")}}`
}
