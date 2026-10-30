import { describe, expect, test } from "bun:test"
import { getAdapter, registerAdapter } from "../../src/control-plane/adapters"
import { ProjectV2 } from "@horizoncode/core/project"
import type { WorkspaceInfo } from "../../src/control-plane/types"

function info(projectID: WorkspaceInfo["projectID"], type: string): WorkspaceInfo {
  return {
    id: "workspace-test" as WorkspaceInfo["id"],
    type,
    name: "workspace-test",
    branch: null,
    directory: null,
    extra: null,
    projectID,
  }
}

function adapter(dir: string) {
  return {
    name: dir,
    description: dir,
    configure(input: WorkspaceInfo) {
      return input
    },
    async create() {},
    async remove() {},
    target() {
      return {
        type: "local" as const,
        directory: dir,
      }
    },
  }
}

describe("control-plane/adapters", () => {
  test("local adapter binds the project directory and never mutates it", async () => {
    const projectID = ProjectV2.ID.make(`project-${Math.random().toString(36).slice(2)}`)
    const local = await getAdapter(projectID, "local")
    const bound = { ...info(projectID, "local"), directory: "/workspace/example" }
    expect(await local.target(bound)).toEqual({ type: "local", directory: "/workspace/example" })
    expect(local.configure(bound, { instance: { directory: "/fallback" } as never })).toMatchObject({
      directory: "/workspace/example",
      branch: null,
      name: "workspace-test",
    })
    // A local workspace must never delete, move, or rewrite the project directory.
    await expect(local.remove(bound)).resolves.toBeUndefined()
    await expect(local.create(bound, {})).resolves.toBeUndefined()
  })

  test("isolates custom adapters by project", async () => {
    const type = `demo-${Math.random().toString(36).slice(2)}`
    const one = ProjectV2.ID.make(`project-${Math.random().toString(36).slice(2)}`)
    const two = ProjectV2.ID.make(`project-${Math.random().toString(36).slice(2)}`)
    registerAdapter(one, type, adapter("/one"))
    registerAdapter(two, type, adapter("/two"))

    expect(await (await getAdapter(one, type)).target(info(one, type))).toEqual({
      type: "local",
      directory: "/one",
    })
    expect(await (await getAdapter(two, type)).target(info(two, type))).toEqual({
      type: "local",
      directory: "/two",
    })
  })

  test("latest install wins within a project", async () => {
    const type = `demo-${Math.random().toString(36).slice(2)}`
    const id = ProjectV2.ID.make(`project-${Math.random().toString(36).slice(2)}`)
    registerAdapter(id, type, adapter("/one"))

    expect(await (await getAdapter(id, type)).target(info(id, type))).toEqual({
      type: "local",
      directory: "/one",
    })

    registerAdapter(id, type, adapter("/two"))

    expect(await (await getAdapter(id, type)).target(info(id, type))).toEqual({
      type: "local",
      directory: "/two",
    })
  })
})
