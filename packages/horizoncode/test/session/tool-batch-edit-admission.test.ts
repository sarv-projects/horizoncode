/**
 * Reproduction for the 13 `edit` calls a live fullstack run denied with
 * "Tool batch denied: invalid tool arguments".
 *
 * Artifact: `.tmp/e2e/logs/fullstack-20261029151801-571080/messages.json`
 * Session directory: `/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase`
 *
 * The 13 denied calls are listed verbatim below (`ARTIFACT_EDITS`). Replaying
 * each one against the file state reconstructed from the same artifact's
 * write/edit history splits them into three measured groups:
 *
 *   - `stale`     (10): `oldString` no longer existed in the file.
 *   - `ambiguous`  (1): `oldString` matched twice.
 *   - `unique`     (2): the call was individually valid and was denied only
 *                      because a sibling in the same batch failed (msgs 102/109).
 *
 * None of the 13 carried an unknown key, a mistyped field, an empty
 * `oldString`, or an over-length string: the published schema accepted all of
 * them. The defect was never argument shape. It was that `admitBatch` folded
 * every prepare-stage refusal into "invalid tool arguments" and denied the whole
 * batch, so (a) the model re-sent the identical edit up to five times instead of
 * repairing the preimage, and (b) two valid edits were lost with their sibling.
 *
 * These tests drive the real admission path: the same `editToolBatchAdmission`
 * projection `SessionTools.resolve` installs, through the real
 * `gateToolCallStream` batch gate. Only `prepareToolBatch` (the Rust Guard call)
 * is a stub, because it needs a live EffectHost.
 */

import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import {
  createToolBatchContext,
  gateToolCallStream,
  toolCallOutcome,
  type ToolBatchDefinition,
  type ToolBatchGateInput,
} from "../../src/session/tool-batch"
import { editToolBatchAdmission, type ToolAdmissionRuntime } from "../../src/session/tool-admission"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const ARTIFACT_ROOT = "/home/sarvesh/business_Dev/agentx"

type ArtifactEdit = {
  readonly index: number
  readonly msg: number
  readonly classification: "stale" | "ambiguous" | "unique"
  readonly filePath: string
  readonly args: { readonly filePath: string; readonly oldString: string; readonly newString: string }
}

const ARTIFACT_EDITS: ReadonlyArray<ArtifactEdit> = [
  {
    "index": 0,
    "msg": 68,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
      "oldString": "RESET=$(awk 'BEGIN{IGNOREcase=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')",
      "newString": "RESET=$(awk 'BEGIN{IGNORECASE=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')"
    }
  },
  {
    "index": 1,
    "msg": 68,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
      "oldString": "NCT=$(awk 'BEGIN{IGNOREcase=1} /^content-type:/{print $2}' /tmp/n1 | tr -d '\\r')",
      "newString": "NCT=$(awk 'BEGIN{IGNORECASE=1} /^content-type:/{print $2}' /tmp/n1 | tr -d '\\r')"
    }
  },
  {
    "index": 2,
    "msg": 69,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
      "oldString": "RESET=$(awk 'BEGIN{IGNOREcase=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')",
      "newString": "RESET=$(awk 'BEGIN{IGNORECASE=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')"
    }
  },
  {
    "index": 3,
    "msg": 70,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
      "oldString": "RESET=$(awk 'BEGIN{IGNOREcase=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')",
      "newString": "RESET=$(awk 'BEGIN{IGNORECASE=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')"
    }
  },
  {
    "index": 4,
    "msg": 71,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/tmp-e2e.sh",
      "oldString": "RESET=$(awk 'BEGIN{IGNOREcase=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')",
      "newString": "RESET=$(awk 'BEGIN{IGNORECASE=1} /^ratelimit-reset:/{print $2}' /tmp/r1 | tr -d '\\r')"
    }
  },
  {
    "index": 5,
    "msg": 102,
    "classification": "unique",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "      { meter: 'storage_gb', customer: 'cus_beta', quantity: 100, timestamp: IN_PERIOD },",
      "newString": "      { meter: 'storage_gb', customer: 'cus_alpha', quantity: 100, timestamp: IN_PERIOD },"
    }
  },
  {
    "index": 6,
    "msg": 102,
    "classification": "ambiguous",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "    const res = await srv.request('/dashboard?account=acct_demo');",
      "newString": "    const res = await srv.request('/dashboard?account=acct_jpy');"
    }
  },
  {
    "index": 7,
    "msg": 109,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "    const usage = await srv.request(\n      `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);",
      "newString": "    const usage = await srv.request(\n      `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);"
    }
  },
  {
    "index": 8,
    "msg": 109,
    "classification": "unique",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "  test('volume invoice line item and idempotent replay', async () => {\n    const key = `inv-vol-evt-${crypto.randomUUID()}`;\n    await postJson(\n      srv,\n      '/v1/events',\n      { meter: 'storage_gb', customer: 'cus_alpha', quantity: 150, timestamp: IN_PERIOD },\n      { ...auth(), 'Idempotency-Key': key },\n    );\n\n    const request = { customer: 'cus_alpha', period_start: PERIOD_START, period_end: PERIOD_END };\n    const res = await postJson(srv, '/v1/invoices', request, auth());\n    expect(res.status).toBe(201);\n    const invoice: any = await res.json();\n    expect(invoice.subtotal).toBe(450);\n    expect(invoice.total).toBe(450);",
      "newString": "  test('volume invoice line item and idempotent replay', async () => {\n    // cus_alpha already has 100 GB of storage_gb from the boundary test; this adds\n    // 50 more (150 total, all in the second volume tier) -> 450 minor units.\n    const key = `inv-vol-evt-${crypto.randomUUID()}`;\n    await postJson(\n      srv,\n      '/v1/events',\n      { meter: 'storage_gb', customer: 'cus_alpha', quantity: 50, timestamp: IN_PERIOD },\n      { ...auth(), 'Idempotency-Key': key },\n    );\n\n    const request = { customer: 'cus_alpha', period_start: PERIOD_START, period_end: PERIOD_END };\n    const res = await postJson(srv, '/v1/invoices', request, auth());\n    expect(res.status).toBe(201);\n    const invoice: any = await res.json();\n    expect(invoice.subtotal).toBe(450);\n    expect(invoice.total).toBe(450);"
    }
  },
  {
    "index": 9,
    "msg": 110,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "    const usage = await srv.request(\n      `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);",
      "newString": "    const usage = await srv.request(\n      `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);"
    }
  },
  {
    "index": 10,
    "msg": 113,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "     `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);",
      "newString": "     `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);"
    }
  },
  {
    "index": 11,
    "msg": 114,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "     `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);",
      "newString": "     `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);"
    }
  },
  {
    "index": 12,
    "msg": 117,
    "classification": "stale",
    "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
    "args": {
      "filePath": "/home/sarvesh/business_Dev/agentx/bench/fullstack/meterbase/test/acceptance.test.ts",
      "oldString": "     `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);",
      "newString": "     `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,\n      { headers: auth() },\n    );\n    const body: any = await usage.json();\n    expect(body.object).toBe('usage');\n    expect(body.quantity).toBe(100);"
    }
  }
]

/** Stand-in for content that cannot contain any of the artifact `oldString`s. */
const STALE_FIXTURE = "// fixture: the requested oldString is not present in this file\n"

const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
} satisfies LanguageModelV3StreamPart

function stream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collect(source: ReadableStream<LanguageModelV3StreamPart>) {
  const result: LanguageModelV3StreamPart[] = []
  const reader = source.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return result
    result.push(next.value)
  }
}

function runtime(directory: string, fs: FSUtil.Interface): ToolAdmissionRuntime {
  return { directory, fs, promise: (effect) => Effect.runPromise(effect) }
}

/**
 * Feed one provider turn through the real batch gate with the real `edit`
 * projection, and report what Guard was asked to admit plus each call outcome.
 */
async function admitTurn(
  input: ToolAdmissionRuntime,
  calls: ReadonlyArray<{ readonly id: string; readonly args: unknown }>,
) {
  const admission = editToolBatchAdmission(input)
  const definition: ToolBatchDefinition = {
    capability: { id: "files.patch", effectClass: "effect" },
    schema: {},
    validate: admission.validate,
    prepare: admission.prepare,
  }
  const guarded: string[][] = []
  const gate: ToolBatchGateInput = {
    sessionID: "session_edit_admission",
    locationRef: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
    turnContextDigest: `sha256:${"a".repeat(64)}`,
    signal: new AbortController().signal,
    definitions: { edit: definition },
    prepareToolBatch: async (request) => {
      guarded.push(request.calls.map((call) => call.callID))
      return {
        status: "admitted_batch",
        calls: request.calls.map((call) => {
          const operations = (call.arguments as { operations?: ReadonlyArray<Record<string, unknown>> }).operations
          const targets = (Array.isArray(operations) ? operations : []).flatMap((operation) =>
            typeof operation.path === "string" && (operation.operation === "write" || operation.operation === "delete")
              ? [
                  {
                    target: operation.path,
                    resource: operation.path,
                    operation: operation.operation,
                    existed: true,
                    ...(operation.operation === "write" ? { executable: operation.executable === true } : {}),
                  },
                ]
              : [],
          )
          const first = targets[0]!
          return {
            callID: call.callID,
            capabilityID: call.capabilityID,
            challenge: {
              challengeID: `ch_${call.callID}`,
              effectID: `eff_${call.callID}`,
              target: first.target,
              resource: first.resource,
              existed: first.existed,
              targets,
            },
          }
        }),
      }
    },
    cancelToolBatch: async () => {},
    context: createToolBatchContext(),
  }
  await collect(
    gateToolCallStream(
      stream([
        ...calls.map(
          (call): LanguageModelV3StreamPart => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: "edit",
            input: JSON.stringify(call.args),
          }),
        ),
        finish,
      ]),
      gate,
    ),
  )
  const outcomes = new Map(calls.map((call) => [call.id, toolCallOutcome(gate.context, call.id)]))
  return { guarded, outcome: (id: string) => outcomes.get(id) }
}

function deniedReason(outcome: ReturnType<typeof toolCallOutcome>): string {
  expect(outcome?.status).toBe("denied")
  return (outcome as { readonly reason: string }).reason
}

/** Relocate an artifact path into this test's temporary workspace. */
function relocate(directory: string, index: number, filePath: string) {
  const relative = path.relative(ARTIFACT_ROOT, filePath)
  return path.join(directory, `case-${String(index).padStart(2, "0")}`, relative)
}

function fixtureContent(edit: ArtifactEdit) {
  if (edit.classification === "unique") return `${edit.args.oldString}\n`
  if (edit.classification === "ambiguous") return `${edit.args.oldString}\n${edit.args.oldString}\n`
  return STALE_FIXTURE
}

it.instance("replays the 13 denied edit calls through the real admission projection", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const admitted = runtime(test.directory, fs)

    for (const edit of ARTIFACT_EDITS) {
      const filePath = relocate(test.directory, edit.index, edit.filePath)
      yield* fs.writeWithDirs(filePath, fixtureContent(edit))
      const turn = yield* Effect.promise(() =>
        admitTurn(admitted, [{ id: `call_${edit.index}`, args: { ...edit.args, filePath } }]),
      )
      const outcome = turn.outcome(`call_${edit.index}`)

      if (edit.classification === "unique") {
        // The call was valid when the artifact recorded it as denied.
        expect(turn.guarded).toEqual([[`call_${edit.index}`]])
        expect(outcome?.status).toBe("admitted")
        continue
      }

      const reason = deniedReason(outcome)
      if (edit.classification === "stale") {
        expect(reason).toContain("Could not find oldString in the file")
      } else {
        expect(reason).toContain("Found multiple matches for oldString")
      }
      // The masking that cost the run five identical re-sends of the same edit.
      expect(reason).not.toBe("invalid tool arguments")
      expect(turn.guarded).toEqual([])
    }
  }),
)

it.instance("admits a valid edit even when a sibling in the same batch is denied", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const admitted = runtime(test.directory, fs)

    // msg 102: call 0 was valid, call 1 matched twice. Both were denied.
    {
      const valid = ARTIFACT_EDITS[5]!
      const ambiguous = ARTIFACT_EDITS[6]!
      const filePath = path.join(test.directory, "batch-102", "acceptance.test.ts")
      yield* fs.writeWithDirs(
        filePath,
        `${valid.args.oldString}\n${ambiguous.args.oldString}\n${ambiguous.args.oldString}\n`,
      )
      const turn = yield* Effect.promise(() =>
        admitTurn(admitted, [
          { id: "msg102_valid", args: { ...valid.args, filePath } },
          { id: "msg102_ambiguous", args: { ...ambiguous.args, filePath } },
        ]),
      )
      expect(turn.guarded).toEqual([["msg102_valid"]])
      expect(turn.outcome("msg102_valid")?.status).toBe("admitted")
      expect(deniedReason(turn.outcome("msg102_ambiguous"))).toContain("Found multiple matches for oldString")
    }

    // msg 109: call 0 was stale, call 1 was valid. Both were denied.
    {
      const stale = ARTIFACT_EDITS[7]!
      const valid = ARTIFACT_EDITS[8]!
      const filePath = path.join(test.directory, "batch-109", "acceptance.test.ts")
      yield* fs.writeWithDirs(filePath, `${valid.args.oldString}\n`)
      const turn = yield* Effect.promise(() =>
        admitTurn(admitted, [
          { id: "msg109_stale", args: { ...stale.args, filePath } },
          { id: "msg109_valid", args: { ...valid.args, filePath } },
        ]),
      )
      expect(turn.guarded).toEqual([["msg109_valid"]])
      expect(turn.outcome("msg109_valid")?.status).toBe("admitted")
      expect(deniedReason(turn.outcome("msg109_stale"))).toContain("Could not find oldString in the file")
    }
  }),
)

it.instance("still denies genuinely malformed edit arguments and real escapes", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const admitted = runtime(test.directory, fs)
    const filePath = path.join(test.directory, "negative", "file.ts")
    yield* fs.writeWithDirs(filePath, "const value = 1\n")

    const shape: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }> = [
      { name: "missing newString", args: { filePath, oldString: "const value = 1" } },
      { name: "non-string oldString", args: { filePath, oldString: 42, newString: "x" } },
      {
        name: "non-boolean replaceAll",
        args: { filePath, oldString: "const value = 1", newString: "x", replaceAll: "yes" },
      },
    ]
    for (const item of shape) {
      const turn = yield* Effect.promise(() => admitTurn(admitted, [{ id: item.name, args: item.args }]))
      expect(deniedReason(turn.outcome(item.name))).toBe("invalid tool arguments")
      expect(turn.guarded).toEqual([])
    }

    const domain: ReadonlyArray<{
      readonly name: string
      readonly args: Record<string, unknown>
      readonly reason: string
    }> = [
      {
        name: "empty oldString on existing file",
        args: { filePath, oldString: "", newString: "x" },
        reason: "oldString cannot be empty",
      },
      {
        name: "identical strings",
        args: { filePath, oldString: "const value = 1", newString: "const value = 1" },
        reason: "identical",
      },
      {
        name: "escaping path",
        args: { filePath: "/etc/passwd", oldString: "root", newString: "nope" },
        reason: "path escapes the workspace",
      },
      {
        name: "stale oldString",
        args: { filePath, oldString: "const released = 2", newString: "x" },
        reason: "Could not find oldString",
      },
    ]
    for (const item of domain) {
      const turn = yield* Effect.promise(() => admitTurn(admitted, [{ id: item.name, args: item.args }]))
      expect(deniedReason(turn.outcome(item.name))).toContain(item.reason)
      expect(turn.guarded).toEqual([])
    }
  }),
)
