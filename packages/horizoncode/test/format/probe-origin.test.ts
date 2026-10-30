import { expect, spyOn, test } from "bun:test"
import { mkdtemp, chmod, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Formatter from "../../src/format/formatter"
import { Process } from "../../src/util/process"

test("formatter availability does not execute AIR or uv probes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hz-formatter-probe-"))
  const previous = process.env.PATH
  const run = spyOn(Process, "run").mockRejectedValue(new Error("unexpected process"))
  const text = spyOn(Process, "text").mockRejectedValue(new Error("unexpected process"))
  try {
    await mkdir(path.join(root, "bin"))
    for (const name of ["air", "uv"]) {
      const file = path.join(root, "bin", name)
      await writeFile(file, "#!/bin/sh\nexit 0\n")
      await chmod(file, 0o755)
    }
    process.env.PATH = path.join(root, "bin")
    const context = { directory: root, worktree: root, experimentalOxfmt: false }
    expect(await Formatter.rlang.enabled(context)).toBe(false)
    expect(await Formatter.uvformat.enabled(context)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    run.mockRestore()
    text.mockRestore()
    await rm(root, { recursive: true })
  }
})
