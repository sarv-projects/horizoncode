import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Config } from "@/config/config"
import { Global } from "@horizoncode/core/global"
import { guardedOriginMcpRuntimeAvailable } from "@/util/guarded-origin"
import { McpAuth } from "./auth"
import { connectedLayer, connectedLayerDeps } from "./connected-layer"
import { Service, stubLayer, use } from "./stub-layer"

export {
  Resource,
  ToolsChanged,
  BrowserOpenFailed,
  Failed,
  NotFoundError,
  UntrustedError,
  Status,
  type ServerInstructions,
  type McpTool,
  type Interface,
  type AuthStatus,
} from "./stub-layer"

export { Service, use }

export const node = LayerNode.make({
  service: Service,
  layer: guardedOriginMcpRuntimeAvailable() ? connectedLayer : stubLayer,
  deps: guardedOriginMcpRuntimeAvailable() ? [...connectedLayerDeps] : [McpAuth.node, Config.node, Global.node],
})

export * as MCP from "."
