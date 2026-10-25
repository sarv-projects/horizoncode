import { Schema } from "effect"

/**
 * Trusted global DAP adapter launch settings. `command[0]` is a HostKernel
 * selector name, never a filesystem path; project and plugin config cannot
 * provide launch authority. No environment or executable path is accepted.
 */
export const Disabled = Schema.Struct({
  disabled: Schema.Literal(true),
})

/** Explicit profile policy; HostKernel still requires fresh debug.evaluate Guard approval per call. */
export const Policy = Schema.Struct({
  allowEvaluate: Schema.Boolean,
}).annotate({ identifier: "ConfigDAPPolicyV1" })

export const Entry = Schema.Union([
  Disabled,
  Schema.Struct({
    command: Schema.mutable(Schema.Array(Schema.String)),
    disabled: Schema.optional(Schema.Boolean),
    dapPolicy: Schema.optional(Policy),
  }),
])

export const Info = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Entry)])
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigDAPV1 from "./dap"
