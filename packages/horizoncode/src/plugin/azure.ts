import type { Hooks } from "@horizoncode/plugin"

type AzureCommand = (args: string[]) => Promise<unknown>

export async function AzureAuthPlugin(): Promise<Hooks> {
  return createAzureAuthHooks()
}

// Kept as a pure construction seam for first-party tests. Providing a command or
// finding `az` on PATH cannot grant process or credential transport authority.
export function createAzureAuthHooks(
  _run?: AzureCommand,
  _request?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  _available?: boolean,
): Hooks {
  const prompts = process.env.AZURE_RESOURCE_NAME ? [] : [{
    type: "text" as const,
    key: "resourceName",
    message: "Enter Azure Resource Name",
    placeholder: "e.g. my-models",
  }]
  return {
    auth: {
      provider: "azure",
      async loader(getAuth) {
        if ((await getAuth()).type === "oauth") {
          throw new Error("Azure CLI OAuth is unavailable until guarded execution is implemented")
        }
        return {}
      },
      methods: [{ type: "api", label: "API key", prompts }],
    },
  }
}
