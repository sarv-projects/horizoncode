import { Schema } from "effect"

export const Parameters = Schema.Struct({
  label: Schema.String.annotate({
    description: "Stable test or acceptance label this command is supposed to satisfy",
  }),
  command: Schema.String.annotate({ description: "Exact verification command to run under Guard" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Working directory; defaults to the workspace root",
  }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Timeout in milliseconds" }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export type VerificationStatus = "passed" | "failed"

export function verificationStatus(exitCode: number | undefined): VerificationStatus {
  return exitCode === 0 ? "passed" : "failed"
}

/** Machine-readable first line for harnesses; human preview follows. */
export function formatVerifyOutput(label: string, status: VerificationStatus, preview: string): string {
  return `${JSON.stringify({ label, status })}\n${preview}`
}
