import { expect, test } from "bun:test"
import { createAzureAuthHooks } from "../../src/plugin/azure"

test("Azure CLI OAuth remains unavailable before process and credential transport admission", async () => {
  let processes = 0
  let requests = 0
  const hooks = createAzureAuthHooks(
    async () => { processes++; throw new Error("unexpected Azure CLI process") },
    async () => { requests++; throw new Error("unexpected credential request") },
    true,
  )
  expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
  const provider = { id: "azure", name: "Azure", source: "custom" as const, env: [] as string[], options: {}, models: {} }
  const oauth = { type: "oauth", access: "private-test-token", refresh: "private-test-token", expires: 0 } as const
  await expect(hooks.auth!.loader!(async () => oauth, provider)).rejects.toThrow("unavailable until guarded execution")
  expect(processes).toBe(0)
  expect(requests).toBe(0)
})
