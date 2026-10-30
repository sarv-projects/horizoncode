import { run as runTui, type TuiInput } from "@horizoncode/tui"
import { Global } from "@horizoncode/core/global"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
