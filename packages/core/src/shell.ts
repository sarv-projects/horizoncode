export * as Shell from "./shell"

import { spawn, spawnSync, type ChildProcess } from "child_process"
import path from "path"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
  supported: boolean
}

export type ProfileKind =
  | "posix.bash"
  | "windows.powershell7"
  | "windows.cmd"
  | "wsl.ubuntu.bash"
  | "wsl.debian.bash"

export type Profile = {
  profileKey: string
  kind: ProfileKind
  executable: string
  login: boolean
  distribution?: string
}

export type Discovery = {
  platform: "linux" | "win32"
  bash?: string
  pwsh7?: string
  cmd?: string
  wsl?: string
  distributions?: string[]
}

export function profilesFromDiscovery(discovery: Discovery): Profile[] {
  const profiles: Profile[] = []
  if (discovery.platform === "linux") {
    if (discovery.bash) {
      profiles.push({
        profileKey: "posix:bash",
        kind: "posix.bash",
        executable: discovery.bash,
        login: true,
      })
    }
    return profiles
  }
  if (discovery.pwsh7 && supportsPowerShell7Path(discovery.pwsh7)) {
    profiles.push({
      profileKey: "windows:powershell7",
      kind: "windows.powershell7",
      executable: discovery.pwsh7,
      login: false,
    })
  }
  if (discovery.cmd) {
    profiles.push({
      profileKey: "windows:cmd",
      kind: "windows.cmd",
      executable: discovery.cmd,
      login: false,
    })
  }
  for (const distribution of discovery.distributions ?? []) {
    const normalized = distribution.toLowerCase()
    const kind =
      normalized.includes("ubuntu") ? "wsl.ubuntu.bash" : normalized.includes("debian") ? "wsl.debian.bash" : undefined
    if (!kind) continue
    profiles.push({
      profileKey: `wsl:${distribution}`,
      kind,
      executable: discovery.wsl ?? "wsl.exe",
      login: true,
      distribution,
    })
  }
  return profiles
}

export function resolveDiscoveredProfile(
  configShell: string | undefined,
  profiles: readonly Profile[],
): Profile | undefined {
  const configured = configShell?.trim()
  if (!configured) {
    return profiles.find((profile) => profile.profileKey === "posix:bash") ??
      profiles.find((profile) => profile.profileKey === "windows:powershell7") ??
      profiles.find((profile) => profile.profileKey === "windows:cmd")
  }
  if (configured.startsWith("wsl:")) {
    return profiles.find((profile) => profile.profileKey === configured && profile.distribution === configured.slice(4))
  }
  return profiles.find(
    (profile) =>
      !profile.distribution &&
      (profile.profileKey === configured ||
        profile.executable === configured ||
        profile.executable.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ===
          configured.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase()),
  )
}

export function resolveProfile(
  configShell?: string,
  discovery?: Discovery | readonly Profile[],
): Profile | undefined {
  if (!discovery) return undefined
  const profiles = "platform" in discovery ? profilesFromDiscovery(discovery) : discovery
  return resolveDiscoveredProfile(configShell, profiles)
}

const DISCOVERY_TIMEOUT_MS = 1500

export function parseWslDistributions(text: Buffer | string): string[] {
  const value = Buffer.isBuffer(text) ? text.toString("utf16le") : text
  return Array.from(
    new Set(
      value
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\0/g, "").trim())
        .filter(Boolean),
    ),
  )
}

export function supportsPowerShell7Path(executable: string): boolean {
  // `pwsh.exe` only exists for PowerShell 7+; `powershell.exe` is the 5.1 binary. A numeric
  // parent directory is checked only when present, so Store/alias and custom install roots are
  // accepted while an explicit `\5.1\pwsh.exe` is still rejected.
  if (path.win32.basename(executable).toLowerCase() !== "pwsh.exe") return false
  const versionDirectory = path.win32.basename(path.win32.dirname(executable))
  const major = versionDirectory.match(/^(\d+)(?:[.-].*)?$/)?.[1]
  return major === undefined || Number(major) >= 7
}

export async function discoverProfiles(): Promise<Profile[]> {
  if (process.platform === "linux") {
    const bash = which("bash")
    return profilesFromDiscovery({ platform: "linux", bash: bash ?? undefined })
  }
  if (process.platform !== "win32") return []

  const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? undefined
  const pwshCandidate = programFiles && path.win32.isAbsolute(programFiles)
    ? path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")
    : undefined
  const pwsh7 = pwshCandidate && supportsPowerShell7Path(pwshCandidate) && stat(pwshCandidate)?.isFile()
    ? pwshCandidate
    : undefined

  const systemRoot = process.env.SystemRoot
  const trustedSystemRoot = systemRoot && path.win32.isAbsolute(systemRoot) ? systemRoot : undefined
  const cmdCandidate = trustedSystemRoot && path.win32.join(trustedSystemRoot, "System32", "cmd.exe")
  const cmd = cmdCandidate && stat(cmdCandidate)?.isFile() ? cmdCandidate : undefined
  const wslCandidate = trustedSystemRoot && path.win32.join(trustedSystemRoot, "System32", "wsl.exe")
  const wsl = wslCandidate && stat(wslCandidate)?.isFile() ? wslCandidate : undefined

  let distributions: string[] = []
  if (wsl) {
    const result = spawnSync(wsl, ["--list", "--quiet"], {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: "buffer",
      windowsHide: true,
    })
    if (result.status === 0 && Buffer.isBuffer(result.stdout)) distributions = parseWslDistributions(result.stdout)
  }
  return profilesFromDiscovery({ platform: "win32", pwsh7, cmd, wsl, distributions })
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string, supported = false): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
    supported,
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  const profiles = await discoverProfiles()
  const listed = shells.filter((shell) => resolve(shell)).map((shell) => {
    const resolved = resolve(shell)
    const supported = Boolean(
      resolved &&
        profiles.some((profile) => profile.executable === resolved || name(profile.executable) === name(resolved)),
    )
    return info(shell, supported)
  })
  for (const profile of profiles) {
    if (!profile.distribution) continue
    listed.push({
      path: `wsl:${profile.distribution}`,
      name: profile.distribution,
      acceptable: true,
      supported: true,
    })
  }
  return listed
}
