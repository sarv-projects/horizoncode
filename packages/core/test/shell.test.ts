import { describe, expect, mock, test } from "bun:test"
import path from "path"
import type { ChildProcess } from "child_process"
import { Shell } from "@horizoncode/core/shell"
import { FSUtil } from "@horizoncode/core/fs-util"
import { which } from "@horizoncode/core/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("defaults tool shells to non-login profiles", () => {
    // Login profiles source user startup files into every tool result; login is
    // opt-in via Config `shell_login`, never the profile default.
    expect(Shell.login("/bin/bash")).toBe(false)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/bin/zsh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/bin/bash", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }

  test("resolves only an explicitly configured discovered profile", () => {
    const discovery = {
      platform: "win32" as const,
      pwsh7: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      cmd: "C:\\Windows\\System32\\cmd.exe",
      wsl: "C:\\Windows\\System32\\wsl.exe",
      distributions: ["Ubuntu-24.04", "Debian"],
    }
    expect(Shell.resolveProfile("pwsh.exe", discovery)).toMatchObject({
      profileKey: "windows:powershell7",
      kind: "windows.powershell7",
      executable: discovery.pwsh7,
      login: false,
    })
    expect(Shell.resolveProfile("cmd.exe", discovery)).toMatchObject({
      profileKey: "windows:cmd",
      kind: "windows.cmd",
      executable: discovery.cmd,
      login: false,
    })
    expect(Shell.resolveProfile("powershell.exe", discovery)).toBeUndefined()
    expect(Shell.resolveProfile("wsl:Ubuntu-24.04", discovery)).toBeUndefined()
    expect(Shell.resolveProfile("wsl:Debian", discovery)).toBeUndefined()
    expect(Shell.resolveProfile("not-installed.exe", discovery)).toBeUndefined()
  })

  test("selects only standard Bash on Linux", () => {
    const discovery = { platform: "linux" as const, bash: "/usr/bin/bash" }
    expect(Shell.resolveProfile("/usr/bin/bash", discovery)).toMatchObject({
      profileKey: "posix:bash",
      kind: "posix.bash",
      executable: "/usr/bin/bash",
      login: false,
    })
    // A login shell is opt-in, and only for the POSIX Bash profile.
    expect(Shell.profilesFromDiscovery(discovery, { login: true })).toMatchObject([
      { profileKey: "posix:bash", login: true },
    ])
    expect(Shell.profilesFromDiscovery(discovery).every((profile) => profile.login === false)).toBe(true)
    expect(Shell.resolveProfile("/usr/bin/zsh", discovery)).toBeUndefined()
    expect(Shell.resolveProfile("bash", { platform: "linux" })).toBeUndefined()
  })

  test("defaults to an installed host shell but never defaults to WSL", () => {
    const profiles = Shell.profilesFromDiscovery({
      platform: "win32",
      pwsh7: "C:\\PowerShell\\pwsh.exe",
      cmd: "C:\\Windows\\cmd.exe",
      distributions: ["Ubuntu"],
    })
    expect(Shell.resolveDiscoveredProfile(undefined, profiles)?.profileKey).toBe("windows:powershell7")
    expect(Shell.resolveDiscoveredProfile("unsupported", profiles)).toBeUndefined()
    const cmdOnly = Shell.profilesFromDiscovery({ platform: "win32", cmd: "C:\\Windows\\cmd.exe" })
    expect(Shell.resolveDiscoveredProfile(undefined, cmdOnly)?.profileKey).toBe("windows:cmd")
  })

  test("rejects Windows PowerShell 5.1 install paths for the PowerShell 7 profile", () => {
    expect(Shell.supportsPowerShell7Path("C:\\Program Files\\PowerShell\\5.1\\pwsh.exe")).toBe(false)
    expect(Shell.supportsPowerShell7Path("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true)
    expect(Shell.supportsPowerShell7Path("C:\\Program Files\\PowerShell\\7.4\\pwsh.exe")).toBe(true)
    expect(Shell.supportsPowerShell7Path("C:\\Windows\\System32\\powershell.exe")).toBe(false)
  })

  test("does not expose WSL profiles on the V1 Windows path", () => {
    const profiles = Shell.profilesFromDiscovery({
      platform: "win32",
      wsl: "C:\\Windows\\System32\\wsl.exe",
      distributions: ["Ubuntu-24.04", "Debian"],
    })
    expect(profiles.some((profile) => profile.profileKey.startsWith("wsl:"))).toBe(false)
  })

  test("does not signal caller-supplied or stale child PID state", async () => {
    const kill = mock(() => undefined)
    const staleChild = { pid: 987654321, kill } as unknown as ChildProcess
    await Shell.killTree(staleChild)
    expect(kill).not.toHaveBeenCalled()
  })

  test("does not resolve a profile without discovery", () => {
    expect(Shell.resolveProfile("bash")).toBeUndefined()
  })
})
