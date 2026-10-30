import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { DirectProviderTransport, LLMClient, RequestExecutor } from "@horizoncode/llm/route"
import { FileSystem, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
/** Default Core behavior is fail-closed; OpenCode replaces this with its Auth-owned adapter. */
export const directProviderTransport = makeGlobalNode({
  service: DirectProviderTransport.Service,
  layer: DirectProviderTransport.unavailableLayer,
  deps: [],
})
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient, directProviderTransport],
})
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"
