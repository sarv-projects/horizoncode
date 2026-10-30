export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Server).pipe(Schema.optional),
}) {}

/**
 * Security-relevant identity of one configured MCP server.
 *
 * Tuning and display fields (timeouts, enable flags) are excluded because they
 * never change what a server can execute or where it sends data. Command, cwd,
 * environment, URL and headers all do, so each participates in the binding.
 * OAuth config is excluded: it changes how the same origin is authenticated,
 * and the origin itself is already part of the binding.
 */
export interface ServerBinding {
  readonly type: "local" | "remote"
  readonly command?: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}

function canonicalEntries(record: Readonly<Record<string, string>> | undefined) {
  return Object.entries(record ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u0001")
}

/**
 * Canonical identity string for one MCP server entry. Env and header values can
 * carry credentials, so callers must hash this value and never log, persist or
 * return it verbatim.
 */
export function serverBinding(entry: ServerBinding): string {
  if (entry.type === "local") {
    return ["local", (entry.command ?? []).join("\u0000"), entry.cwd ?? "", canonicalEntries(entry.environment)].join("\u0002")
  }
  return ["remote", entry.url ?? "", canonicalEntries(entry.headers)].join("\u0002")
}
