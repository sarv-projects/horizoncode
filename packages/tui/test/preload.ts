import path from "node:path"
import fs from "node:fs"

// Confine test data, db, and XDG directories to repo-contained sandbox
const repoRoot = path.resolve(import.meta.dir, "../../..")
const sandboxDir = path.join(repoRoot, "packages/tui/.p7-sandbox")
fs.mkdirSync(sandboxDir, { recursive: true })

process.env["OPENCODE_DB"] = ":memory:"
process.env["TMPDIR"] = sandboxDir
process.env["XDG_DATA_HOME"] = path.join(sandboxDir, "share")
process.env["XDG_CACHE_HOME"] = path.join(sandboxDir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(sandboxDir, "config")
process.env["XDG_STATE_HOME"] = path.join(sandboxDir, "state")

const testHome = path.join(sandboxDir, "home")
fs.mkdirSync(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

const worktreeDir = path.join(sandboxDir, "worktree")
fs.mkdirSync(worktreeDir, { recursive: true })
process.env["OPENCODE_TEST_WORKTREE"] = worktreeDir
