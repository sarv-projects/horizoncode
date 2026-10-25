import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Effect, Layer, Context } from "effect"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

export class PluginShellUnavailableError extends Error {
  readonly _tag = "PluginShellUnavailableError"
  readonly reason = "guard_not_verified"
  constructor() {
    super(
      "Plugin shell access is unavailable: plugin shell execution must be mediated by the canonical Rust Guard/ExecutionHost route, which is not registered",
    )
    this.name = "PluginShellUnavailableError"
  }
}

/**
 * Plugin shell capability. `PluginInput.$` previously handed plugins the host's raw
 * `Bun.$` runner: an unguarded local process/write origin reachable from plugin hook code
 * on model-driven events. Plugin shell effects may only run through the canonical Rust
 * Guard/ExecutionHost route (trusted executable, bounded target, one-use lease), and no
 * such route is registered, so this object refuses with a typed error instead of spawning.
 * The full `BunShell` surface is implemented so an existing plugin gets a deterministic
 * typed refusal rather than a missing method or an unguarded execution.
 */
export function unavailablePluginShell(): PluginInput["$"] {
  const refuse = () => {
    throw new PluginShellUnavailableError()
  }
  const shell = ((..._args: never[]) => refuse()) as unknown as PluginInput["$"]
  return Object.assign(shell, {
    braces: () => refuse(),
    escape: () => refuse(),
    env: () => refuse(),
    cwd: () => refuse(),
    nothrow: () => refuse(),
    throws: () => refuse(),
  })
}

// Plugin code is an effect origin: initialization, config/event hooks, request hooks,
// disposal hooks, and workspace adapters can perform network, process, credential, or
// filesystem effects. Until those operations have a canonical Guard/ExecutionHost path,
// expose no hooks and do not import or initialize either built-in or external plugins.
const layer = Layer.succeed(
  Service,
  Service.of({
    trigger: (_name, _input, output) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [],
})

export * as Plugin from "."
