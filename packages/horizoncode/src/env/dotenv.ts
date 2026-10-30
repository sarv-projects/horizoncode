import path from "path"
import { readFile, stat } from "fs/promises"

/**
 * `.env` is the single local credential store. The CLI loads `<cwd>/.env`
 * into the process environment before any command runs, so provider
 * credentials come from an ordinary gitignored file instead of the desktop
 * keyring. Loading is read-only, size-capped, permission-checked, never
 * expands variables, and never overrides an already-exported variable.
 */
export const MAX_DOTENV_BYTES = 64 * 1024

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface DotEnvEntry {
  readonly name: string
  readonly value: string
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === `"` || quote === `'`) && value.endsWith(quote)) return value.slice(1, -1)
  }
  return value
}

/** Parses dotenv text into ordered entries; comments and malformed lines are skipped. */
export function parseDotEnv(text: string): DotEnvEntry[] {
  const entries: DotEnvEntry[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").replace(/^\uFEFF/, "").trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line
    const separator = assignment.indexOf("=")
    if (separator <= 0) continue
    const name = assignment.slice(0, separator).trim()
    if (!ENV_NAME.test(name)) continue
    entries.push({ name, value: unquote(assignment.slice(separator + 1).trim()) })
  }
  return entries
}

export interface LoadProjectDotEnvResult {
  /** Variable names taken from `.env`. Values are never surfaced. */
  readonly applied: readonly string[]
  /** Variable names that were already exported and therefore left untouched. */
  readonly skipped: readonly string[]
  /** Why the file was refused, when it was. Neither names nor values leak. */
  readonly refused?: string
}

/**
 * Loads `<directory>/.env` into `env` (default `process.env`). A missing file
 * is a silent no-op; an unsafe file is refused whole rather than partially
 * applied. The result only ever reports variable names.
 */
export async function loadProjectDotEnv(options: {
  directory?: string
  env?: Record<string, string | undefined>
} = {}): Promise<LoadProjectDotEnvResult> {
  const env = options.env ?? process.env
  const file = path.join(options.directory ?? process.cwd(), ".env")
  let content: string
  try {
    const info = await stat(file)
    if (!info.isFile()) return { applied: [], skipped: [], refused: "not a regular file" }
    if (info.size > MAX_DOTENV_BYTES) {
      return { applied: [], skipped: [], refused: "larger than the 64 KiB limit" }
    }
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        return { applied: [], skipped: [], refused: "not owned by the current user" }
      }
      if ((info.mode & 0o022) !== 0) return { applied: [], skipped: [], refused: "writable by group or others" }
    }
    content = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { applied: [], skipped: [] }
    return { applied: [], skipped: [], refused: "could not be read" }
  }
  const applied: string[] = []
  const skipped: string[] = []
  for (const entry of parseDotEnv(content)) {
    if (env[entry.name] !== undefined) {
      skipped.push(entry.name)
      continue
    }
    env[entry.name] = entry.value
    applied.push(entry.name)
  }
  return { applied, skipped }
}

export * as DotEnv from "./dotenv"