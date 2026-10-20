import { afterEach, expect, test } from "bun:test"
import { AzureAuthPlugin, createAzureAuthHooks } from "../../src/plugin/azure"

const resource = process.env.AZURE_RESOURCE_NAME
afterEach(() => {
  if (resource === undefined) delete process.env.AZURE_RESOURCE_NAME
  else process.env.AZURE_RESOURCE_NAME = resource
})

test("Azure production hooks expose only API-key auth without running a CLI", async () => {
  delete process.env.AZURE_RESOURCE_NAME
  const hooks = await AzureAuthPlugin()
  expect(hooks.auth?.provider).toBe("azure")
  expect(hooks.auth?.methods).toEqual([{
    type: "api", label: "API key", prompts: [{
      type: "text", key: "resourceName", message: "Enter Azure Resource Name", placeholder: "e.g. my-models",
    }],
  }])
})

test("Azure API-key configuration preserves resource-name prompts and performs no effects", async () => {
  process.env.AZURE_RESOURCE_NAME = "test-resource"
  let calls = 0
  const hooks = createAzureAuthHooks(async () => { calls++; return {} }, async () => { calls++; return new Response() }, true)
  expect(hooks.auth?.methods[0].prompts).toEqual([])
  const provider = { id: "azure", name: "Azure", source: "custom" as const, env: [] as string[], options: {}, models: {} }
  expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "test-key" }), provider)).toEqual({})
  expect(calls).toBe(0)
})
