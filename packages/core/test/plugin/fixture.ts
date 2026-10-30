import { AgentV2 } from "@horizoncode/core/agent"
import { AISDK } from "@horizoncode/core/aisdk"
import { Catalog } from "@horizoncode/core/catalog"
import { CommandV2 } from "@horizoncode/core/command"
import { Credential } from "@horizoncode/core/credential"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { EventV2 } from "@horizoncode/core/event"
import { FileSystem } from "@horizoncode/core/filesystem"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Integration } from "@horizoncode/core/integration"
import { Location } from "@horizoncode/core/location"
import { Npm } from "@horizoncode/core/npm"
import { PluginV2 } from "@horizoncode/core/plugin"
import { Reference } from "@horizoncode/core/reference"
import { SkillV2 } from "@horizoncode/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
