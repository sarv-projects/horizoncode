/**
 * HorizonCode `update` command — update CHECK plus an explicit, LOCAL_ONLY
 * UNSIGNED upgrade path.
 *
 * Governance: arch_V1/17-GOVERNANCE-DECISIONS.md DEC-V1-12 deferred release
 * signing and automatic self-update beyond V1. Consequences encoded here:
 *   - The startup hook only CHECKS metadata (a version string) and at most
 *     prints a one-line notice. It never downloads or executes code.
 *   - `apply` refuses to run unless HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 AND a
 *     64-hex digest pin are supplied; it then delegates to the audited shell
 *     updater scripts/update/horizoncode-update.sh which re-verifies both.
 *   - The default posture is notify-only; auto-upgrade is opt-in, labeled
 *     unsigned, and still digest-pinned.
 *
 * The pure helpers (parseSemver / compareSemver / planUpdate /
 * parseLatestVersionPayload / applyAuthorization) are covered offline by
 * scripts/update/test-update-check.test.ts (bun test, mocked endpoint).
 */
import type { Argv } from "yargs"
import { spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { InstallationVersion } from "@horizoncode/core/installation/version"

export interface Semver {
  major: number
  minor: number
  patch: number
  /** dot-separated identifiers without the leading '-' ; empty = release */
  prerelease: string[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(input: string): Semver | null {
  const match = SEMVER_RE.exec(input.trim())
  if (!match) return null
  const [, major, minor, patch, pre] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split(".") : [],
  }
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1 when a < b, 0 when equal, 1 when a > b, null when either is invalid. */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return null
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const cmp = comparePrereleaseIdentifier(left.prerelease[i]!, right.prerelease[i]!)
    if (cmp !== 0) return cmp < 0 ? -1 : 1
  }
  if (left.prerelease.length === right.prerelease.length) return 0
  return left.prerelease.length < right.prerelease.length ? -1 : 1
}

export type UpdateRelation = "up-to-date" | "update-available" | "ahead" | "incomparable"

export interface UpdatePlan {
  relation: UpdateRelation
  current: string
  latest: string | null
}

export function planUpdate(current: string, latest: string | null | undefined): UpdatePlan {
  if (!latest) return { relation: "incomparable", current, latest: null }
  const cmp = compareSemver(current, latest)
  if (cmp === null) return { relation: "incomparable", current, latest }
  return { relation: cmp < 0 ? "update-available" : cmp > 0 ? "ahead" : "up-to-date", current, latest }
}

/** Extracts a version from a GitHub release JSON body or a bare text body. */
export function parseLatestVersionPayload(body: string): string | null {
  const tag = /"tag_name"\s*:\s*"([^"]+)"/.exec(body)
  if (tag?.[1]) return parseSemver(tag[1]) ? tag[1] : null
  const name = /"name"\s*:\s*"v?(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)"/.exec(body)
  if (name?.[1]) return name[1]
  const trimmed = body.trim()
  if (parseSemver(trimmed)) return trimmed
  return null
}

export const DEFAULT_UPDATE_ENDPOINT = "https://api.github.com/repos/sarv-projects/horizoncode/releases/latest"

export interface CheckOptions {
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  currentVersion?: string
}

export interface CheckResult extends UpdatePlan {
  endpoint: string
  error: string | null
}

/** Metadata-only update check. Never throws; network failure => error result. */
export async function checkForUpdate(options: CheckOptions = {}): Promise<CheckResult> {
  const endpoint = options.endpoint ?? DEFAULT_UPDATE_ENDPOINT
  const timeoutMs = options.timeoutMs ?? 4000
  const currentVersion = options.currentVersion ?? InstallationVersion
  const doFetch = options.fetchImpl ?? fetch
  // Local dev builds report "local"; there is nothing meaningful to compare.
  if (currentVersion === "local") {
    return { relation: "incomparable", current: currentVersion, latest: null, endpoint, error: "local build" }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(endpoint, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      if (!response.ok) {
        return {
          relation: "incomparable",
          current: currentVersion,
          latest: null,
          endpoint,
          error: `HTTP ${response.status}`,
        }
      }
      const body = await response.text()
      const latest = parseLatestVersionPayload(body)
      return { ...planUpdate(currentVersion, latest), endpoint, error: latest ? null : "unparseable payload" }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return {
      relation: "incomparable",
      current: currentVersion,
      latest: null,
      endpoint,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function formatUpdateNotice(plan: CheckResult): string | null {
  if (plan.relation !== "update-available" || !plan.latest) return null
  return `HorizonCode ${plan.latest} is available (you have ${plan.current}). Automatic updates are disabled by policy (DEC-V1-12); run \`horizoncode update check\`.`
}

/** Opt-in gate for the UNSIGNED remote upgrade path (DEC-V1-12). */
export function applyAuthorization(env: Record<string, string | undefined>, pin?: string): { ok: true } | { ok: false; reason: string } {
  if (env["HORIZONCODE_ALLOW_UNSIGNED_UPDATE"] !== "1") {
    return {
      ok: false,
      reason:
        "remote/automatic upgrades are deferred beyond V1 (DEC-V1-12). Set HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 to acknowledge the UNSIGNED upgrade, or use `horizoncode update local --from-repo <checkout>` (preferred, no remote code).",
    }
  }
  const digest = pin ?? env["HORIZONCODE_UPDATE_SHA256"] ?? ""
  if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
    return { ok: false, reason: "a 64-hex digest pin is required (--sha256 or HORIZONCODE_UPDATE_SHA256)." }
  }
  return { ok: true }
}

/**
 * Fire-and-forget startup CHECK: notify-only, TTY-only, fast-failing.
 * Resolves immediately after scheduling; never rejects, never blocks startup,
 * never executes downloaded code (DEC-V1-12).
 */
export async function startUpdateCheck(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (env["HORIZONCODE_UPDATE_CHECK"] === "0") return
  if (env["CI"] || env["GITHUB_ACTIONS"]) return
  if (!process.stdout.isTTY || !process.stderr.isTTY) return
  if (InstallationVersion === "local") return
  try {
    const result = await checkForUpdate({ currentVersion: InstallationVersion, timeoutMs: 2000 })
    const notice = formatUpdateNotice(result)
    if (notice) process.stderr.write(notice + "\n")
  } catch {
    // Advisory only: an update check must never affect CLI behavior.
  }
}

export interface UpdateArgs {
  action?: "check" | "local" | "apply"
  endpoint?: string
  sha256?: string
  json?: boolean
  quiet?: boolean
  current?: string
  "target-version"?: string
  "asset-name"?: string
  "endpoint-base"?: string
  fromRepo?: string
}

function resolveUpdaterScript(): string | null {
  const candidates: string[] = []
  if (process.env.HORIZONCODE_UPDATE_SCRIPT) candidates.push(process.env.HORIZONCODE_UPDATE_SCRIPT)
  candidates.push(path.join(import.meta.dir, "../../../../scripts/update/horizoncode-update.sh"))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function runUpdater(argv: string[]): Promise<number> {
  const script = resolveUpdaterScript()
  if (!script) {
    return Promise.reject(
      new Error("updater script not found (set HORIZONCODE_UPDATE_SCRIPT, or run from a checkout containing scripts/update/horizoncode-update.sh)."),
    )
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn("bash", [script, ...argv], { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (exitCode) => resolve(exitCode ?? 1))
  })
}

export const UpdateCommand = {
  command: "update [action]",
  describe: "check for HorizonCode updates; apply is explicit, digest-pinned and UNSIGNED (DEC-V1-12)",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        describe: "check (default), local (upgrade from a checkout), or apply (explicit opt-in)",
        type: "string",
        choices: ["check", "local", "apply"],
        default: "check" as const,
      })
      .option("endpoint", {
        describe: "metadata endpoint for check (or HORIZONCODE_UPDATE_ENDPOINT)",
        type: "string",
      })
      .option("current", {
        describe: "override the running version (testing)",
        type: "string",
      })
      .option("json", { describe: "machine-readable check output", type: "boolean" })
      .option("quiet", { describe: "no output, exit code only", type: "boolean" })
      .option("sha256", { describe: "digest pin for apply (or HORIZONCODE_UPDATE_SHA256)", type: "string" })
      .option("target-version", { describe: "target version for apply", type: "string" })
      .option("endpoint-base", { describe: "release base URL for apply", type: "string" })
      .option("asset-name", { describe: "release asset name for apply", type: "string" })
      .option("from-repo", { describe: "checkout path for the local upgrade path", type: "string" }),
  handler: async (args: UpdateArgs) => {
    const action = args.action ?? "check"
    if (action === "check") {
      const endpoint = args.endpoint ?? process.env.HORIZONCODE_UPDATE_ENDPOINT ?? DEFAULT_UPDATE_ENDPOINT
      const result = await checkForUpdate({ endpoint, currentVersion: args.current ?? InstallationVersion })
      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            status: result.relation,
            current: result.current,
            latest: result.latest,
            endpoint: result.endpoint,
            error: result.error,
            auto: "disabled-by-policy (DEC-V1-12)",
          }) + "\n",
        )
        return
      }
      if (!args.quiet) {
        process.stderr.write(`current: ${result.current}\nlatest:  ${result.latest ?? "unknown"} (${result.endpoint})\nstatus:  ${result.relation}\n`)
        if (result.error) process.stderr.write(`note:    check error: ${result.error}\n`)
        if (result.relation === "update-available" && result.latest) {
          process.stderr.write(
            `automatic updates are DISABLED by policy (DEC-V1-12). Upgrade explicitly:\n` +
              `  horizoncode update local --from-repo <checkout>   # LOCAL_ONLY_UNSIGNED (preferred)\n` +
              `  HORIZONCODE_ALLOW_UNSIGNED_UPDATE=1 horizoncode update apply --sha256 <pin> --target-version ${result.latest}\n`,
          )
        }
      }
      return
    }

    if (action === "local") {
      const fromRepo = args.fromRepo ?? process.env.HORIZONCODE_UPDATE_FROM_REPO
      if (!fromRepo) throw new Error("update local: --from-repo <dir> is required.")
      process.stderr.write(`update local: LOCAL_ONLY_UNSIGNED upgrade from checkout ${fromRepo} (no remote code; DEC-V1-12).\n`)
      const code = await runUpdater(["local", "--from-repo", fromRepo])
      if (code !== 0) throw new Error(`update local failed (exit ${code}).`)
      return
    }

    if (action === "apply") {
      const auth = applyAuthorization(process.env, args.sha256)
      if (!auth.ok) {
        throw new Error(`update apply refused: ${auth.reason}`)
      }
      const version = args["target-version"] ?? process.env.HORIZONCODE_UPDATE_TARGET_VERSION
      if (!version) throw new Error("update apply: --version is required (no silent 'latest' upgrade, DEC-V1-12).")
      const argv = ["apply", "--version", version, "--sha256", args.sha256 ?? process.env.HORIZONCODE_UPDATE_SHA256 ?? ""]
      if (args["endpoint-base"]) argv.push("--endpoint-base", args["endpoint-base"])
      if (args["asset-name"]) argv.push("--asset-name", args["asset-name"])
      process.stderr.write("update apply: UNSIGNED remote upgrade (signing deferred, DEC-V1-12); digest pin required.\n")
      const code = await runUpdater(argv)
      if (code !== 0) throw new Error(`update apply failed (exit ${code}).`)
      return
    }

    throw new Error(`unknown update action '${action}' (expected check|local|apply)`)
  },
}
