#!/usr/bin/env bun
/**
 * HorizonCode V1 E2E smoke — authorized OpenCode free-model journey (LM-018).
 *
 * One command, fail-closed. The script asserts that the resolved route is
 * exactly the anonymous, credential-free, zero-priced OpenCode offer and that
 * no paid/BYO route could be selected; only then does it send one bounded
 * coding turn. It captures the provider request ID, usage provenance and cost
 * provenance (expected FREE/UNKNOWN, never invented) and prints a JSON
 * evidence record.
 *
 * Usage:
 *   bun packages/horizoncode/test/e2e/free-model-smoke.ts --check
 *       Preconditions only: boot the in-process server, evaluate the free-route
 *       gate, print the verdict. Never creates a session, never prompts.
 *       Runs with zero provider/network requests (set OPENCODE_DISABLE_MODELS_FETCH=1
 *       to also suppress the startup catalog refresh).
 *
 *   bun packages/horizoncode/test/e2e/free-model-smoke.ts [--model provider/model]
 *       [--timeout ms] [--task text] [--out path] [--dir path]
 *       Preconditions, then ONE bounded coding turn on the free route.
 *       Requires OPENCODE_SERVER_PASSWORD (authenticated Session principal —
 *       without it the direct provider drain cannot bind an owner).
 *
 * Exit codes:
 *   0  VERIFIED      preconditions passed, turn completed, provenance captured
 *   2  REFUSED       a precondition was false (paid route possible, no free
 *                    route, auth missing, ...) — nothing was dispatched
 *   3  PROVENANCE    the turn completed but route/cost provenance failed
 *                    (fallback detected, nonzero cost, missing provenance)
 *   4  PROVIDER      the provider rejected/rate-limited the request — reported
 *                    honestly as NOT RUN, no retry, no fallback, no second route
 *   5  TIMEOUT       the bounded turn did not finish inside --timeout
 *   1  ERROR         unexpected internal failure
 *
 * The pure gate/provenance functions below are imported and unit-tested
 * offline by ./free-model-smoke.test.ts — no server, no network, no provider.
 */

// ---------------------------------------------------------------------------
// Pure gate (unit-tested offline)
// ---------------------------------------------------------------------------

export type ProviderListEntry = {
  id?: string
  source?: string
  env?: readonly string[]
  [key: string]: unknown
}

export type FreeRouteCatalog = Readonly<Record<string, unknown>>

export type FreeRouteGateInput = {
  /** `GET /provider` ListResult projection. */
  providerList: {
    all?: readonly ProviderListEntry[]
    default?: Readonly<Record<string, string>>
    anonymousFreeProviders?: readonly string[] | undefined
    anonymousFreeModels?: readonly string[] | undefined
    connected?: readonly string[] | undefined
    catalogSnapshot?: FreeRouteCatalog | undefined
  }
  /** Effective config (`GET /config`). */
  config: {
    model?: string | undefined
    small_model?: string | undefined
    provider?: Readonly<Record<string, unknown>> | undefined
    enabled_providers?: readonly string[] | undefined
    disabled_providers?: readonly string[] | undefined
  }
  env?: Readonly<Record<string, string | undefined>> | undefined
  /** Explicit `--model provider/model` selection. */
  cliModel?: string | undefined
  /**
   * Turn mode only: an authenticated server principal must exist or the direct
   * provider drain cannot bind a Session owner. `undefined` skips the check so
   * pure route tests can omit it; `false` is a hard refusal.
   */
  serverPasswordConfigured?: boolean | undefined
}

export type FreeRouteRefusal = { code: string; reason: string }

export type FreeRoutePlan = {
  route: { providerID: string; modelID: string; ref: string; source: "cli" | "config" | "default" }
  freeModels: readonly string[]
  catalog?: FreeRouteCatalog | undefined
}

export type FreeRouteGateResult =
  | {
      ok: true
      refusals: []
      route: FreeRoutePlan["route"]
      freeModels: readonly string[]
      catalog?: FreeRouteCatalog | undefined
      plan: FreeRoutePlan
    }
  | { ok: false; refusals: FreeRouteRefusal[]; plan?: undefined; route?: undefined }

/**
 * Evaluate every precondition for the authorized free-model journey.
 *
 * Collects ALL refusals (never first-fail) so a refused run reports the exact
 * complete matrix. A paid route "could be selected" whenever: an env credential
 * exists, the opencode provider left the anonymous custom source, any other
 * provider is connected (credentialed/config/BYO), config pins a model or
 * small_model outside the free set, a custom provider block exists, a paid
 * provider is enabled, or opencode is disabled.
 */
export function evaluateFreeRouteGate(input: FreeRouteGateInput): FreeRouteGateResult {
  const refusals: FreeRouteRefusal[] = []
  const env = input.env ?? {}
  const providerList = input.providerList
  const config = input.config

  // 1. Environment credential for the OpenCode provider itself.
  if (env.OPENCODE_API_KEY) {
    refusals.push({
      code: "ENV_OPENSEL_CREDENTIAL",
      reason:
        "OPENCODE_API_KEY is set in the environment; the OpenCode route would be credentialed, " +
        "not anonymous, and the paid model catalog would become selectable. Unset it for the free-model smoke.",
    })
  }

  // 2. The opencode provider must still be the anonymous custom-source entry.
  const opencode = (providerList.all ?? []).find((item) => item.id === "opencode")
  if (!opencode) {
    refusals.push({
      code: "OPENSEL_NOT_ANONYMOUS",
      reason: "the opencode provider is missing from the resolved provider list; the anonymous free route cannot be proven",
    })
  } else if (opencode.source !== "custom") {
    refusals.push({
      code: "OPENSEL_NOT_ANONYMOUS",
      reason: `the opencode provider source is "${String(opencode.source)}" instead of "custom" (an env/api/config credential has taken over the route)`,
    })
  }

  // 3. Nothing other than opencode may be connected (credentialed, config- or
  //    env-sourced, or BYO). connected[] already reflects env/auth/config loads.
  const others = (providerList.connected ?? []).filter((id) => id !== "opencode")
  if (others.length > 0) {
    refusals.push({
      code: "PAID_ROUTE_CONNECTED",
      reason:
        `connected providers beyond opencode: ${others.join(", ")} — a credentialed or BYO route ` +
        `could be selected. Disconnect or disable them for the free-model smoke.`,
    })
  }

  // 4. The anonymous free projection must exist and be non-empty.
  const freeModels = providerList.anonymousFreeModels ?? []
  const freeProviders = providerList.anonymousFreeProviders ?? []
  if (!freeProviders.includes("opencode") || freeModels.length === 0) {
    refusals.push({
      code: "NO_FREE_MODEL",
      reason:
        "no anonymous free OpenCode model is currently eligible (anonymousFreeModels is empty or opencode is not " +
        "an anonymous-free provider): catalog missing, pricing not explicitly zero, or status not active",
    })
  }

  // 5. Config must not declare custom (BYO) providers.
  const configProviders = Object.keys(config.provider ?? {})
  if (configProviders.length > 0) {
    refusals.push({
      code: "CUSTOM_PROVIDER_CONFIG",
      reason: `config declares custom provider configuration: ${configProviders.join(", ")} — BYO/provider routes are not allowed in the free-model smoke`,
    })
  }

  // 6. enabled_providers must not enable anything beyond opencode.
  const extraEnabled = (config.enabled_providers ?? []).filter((id) => id !== "opencode")
  if (extraEnabled.length > 0) {
    refusals.push({
      code: "PAID_PROVIDER_ENABLED",
      reason: `enabled_providers enables paid routes: ${extraEnabled.join(", ")}`,
    })
  }

  // 7. opencode itself must not be disabled.
  if ((config.disabled_providers ?? []).includes("opencode")) {
    refusals.push({
      code: "OPENSEL_DISABLED",
      reason: "disabled_providers disables opencode, so no free route exists",
    })
  }

  // 8. small_model (title/background dispatch) must stay inside the free set.
  if (config.small_model && !freeModels.includes(config.small_model)) {
    refusals.push({
      code: "CONFIG_SMALL_MODEL_NOT_FREE",
      reason: `config small_model "${config.small_model}" is outside the anonymous free set [${freeModels.join(", ")}]; background dispatch could leave the free route`,
    })
  }

  // 9. Every model pin must resolve inside the free set. All pins are checked
  //    independently: any paid pin is refused even if another pin is free.
  let cliRef: string | undefined
  if (input.cliModel !== undefined) {
    if (freeModels.includes(input.cliModel)) {
      cliRef = input.cliModel
    } else {
      refusals.push({
        code: "CLI_MODEL_NOT_FREE",
        reason: `--model "${input.cliModel}" is not in the anonymous free set [${freeModels.join(", ")}]`,
      })
    }
  }

  let configRef: string | undefined
  if (config.model !== undefined) {
    if (freeModels.includes(config.model)) {
      configRef = config.model
    } else {
      refusals.push({
        code: "CONFIG_MODEL_NOT_FREE",
        reason: `config model "${config.model}" is not in the anonymous free set [${freeModels.join(", ")}]`,
      })
    }
  }

  const defaultModelID = (providerList.default ?? {}).opencode
  const defaultRef = defaultModelID !== undefined ? `opencode/${defaultModelID}` : undefined
  if (defaultRef !== undefined && !freeModels.includes(defaultRef)) {
    refusals.push({
      code: "DEFAULT_MODEL_NOT_FREE",
      reason: `default model "${defaultRef}" is not in the anonymous free set [${freeModels.join(", ")}]`,
    })
  }

  // 10. A selection must be resolvable at all (cli > config > default).
  const selection = cliRef ?? configRef ?? defaultRef
  if (selection === undefined && cliRef === undefined && configRef === undefined) {
    // Only unreachable when no pin exists at all; a failed pin already refused above.
    if (input.cliModel === undefined && config.model === undefined && defaultRef === undefined) {
      refusals.push({
        code: "SELECTION_UNRESOLVED",
        reason: "no model selection is available: no --model, no config.model and no opencode default in the provider list",
      })
    }
  }

  // 11. Turn mode requires an authenticated server principal so the direct
  //     provider drain can bind an authenticated Session owner.
  if (input.serverPasswordConfigured === false) {
    refusals.push({
      code: "SERVER_AUTH_UNCONFIGURED",
      reason:
        "OPENCODE_SERVER_PASSWORD is not set; without an authenticated server principal the direct provider " +
        "request cannot bind an authenticated Session owner. Set it for the bounded turn.",
    })
  }

  if (refusals.length > 0) return { ok: false, refusals }

  const source: FreeRoutePlan["route"]["source"] = cliRef !== undefined ? "cli" : configRef !== undefined ? "config" : "default"
  const ref = selection!
  const separator = ref.indexOf("/")
  const route: FreeRoutePlan["route"] = {
    providerID: ref.slice(0, separator),
    modelID: ref.slice(separator + 1),
    ref,
    source,
  }
  return {
    ok: true,
    refusals: [],
    route,
    freeModels,
    catalog: providerList.catalogSnapshot,
    plan: { route, freeModels, catalog: providerList.catalogSnapshot },
  }
}

// ---------------------------------------------------------------------------
// Provenance capture (unit-tested offline)
// ---------------------------------------------------------------------------

export type UsageProvenanceLike = {
  providerID?: string
  modelID?: string
  operationID?: string
  requestID?: string
  cost?: { status?: string; value?: number; [key: string]: unknown }
  tokens?: { [key: string]: unknown }
  [key: string]: unknown
}

export type ProvenanceCandidate = {
  source: "event" | "message"
  providerID?: string
  modelID?: string
  usageProvenance?: UsageProvenanceLike
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function candidateFrom(
  source: "event" | "message",
  info: Record<string, unknown>,
  usageProvenance?: UsageProvenanceLike,
): ProvenanceCandidate {
  const provenance = usageProvenance ?? (isRecord(info.usageProvenance) ? (info.usageProvenance as UsageProvenanceLike) : undefined)
  return {
    source,
    providerID: typeof info.providerID === "string" ? info.providerID : provenance?.providerID,
    modelID: typeof info.modelID === "string" ? info.modelID : provenance?.modelID,
    usageProvenance: provenance,
  }
}

/**
 * Collect route/provenance candidates from the raw event stream and the
 * persisted messages of the smoke session. Shape-tolerant on purpose: the
 * smoke must capture what the product actually emits rather than crash on
 * projection drift, and it must never fabricate a candidate.
 */
export function collectProvenanceCandidates(input: {
  events?: readonly unknown[]
  messages?: readonly unknown[]
}): ProvenanceCandidate[] {
  const candidates: ProvenanceCandidate[] = []

  for (const raw of input.events ?? []) {
    if (!isRecord(raw)) continue
    if (raw.type === "message.part.updated" && isRecord(raw.properties)) {
      const part = raw.properties.part
      if (isRecord(part) && part.type === "step-finish" && isRecord(part.usageProvenance)) {
        const provenance = part.usageProvenance as UsageProvenanceLike
        candidates.push({
          source: "event",
          providerID: provenance.providerID,
          modelID: provenance.modelID,
          usageProvenance: provenance,
        })
      } else if (isRecord(part) && part.type === "message.updated" && isRecord(part.info)) {
        // defensive: some projections inline the message on the part event
        candidates.push(candidateFrom("event", part.info))
      }
    } else if (raw.type === "message.updated" && isRecord(raw.properties) && isRecord(raw.properties.info)) {
      const info = raw.properties.info
      if (info.role === "assistant") candidates.push(candidateFrom("event", info))
    }
  }

  const messages = input.messages ?? []
  for (const raw of messages) {
    if (!isRecord(raw)) continue
    // `{info, parts}` envelope or a bare message object.
    const info = isRecord(raw.info) ? raw.info : raw
    const role = info.role
    if (role === "user") continue
    if (role !== "assistant" && info.usageProvenance === undefined) continue
    candidates.push(candidateFrom("message", info))

    const parts = Array.isArray(raw.parts) ? raw.parts : Array.isArray(info.parts) ? info.parts : []
    for (const part of parts) {
      if (isRecord(part) && part.type === "step-finish" && isRecord(part.usageProvenance)) {
        const provenance = part.usageProvenance as UsageProvenanceLike
        candidates.push({
          source: "message",
          providerID: provenance.providerID ?? (typeof info.providerID === "string" ? info.providerID : undefined),
          modelID: provenance.modelID ?? (typeof info.modelID === "string" ? info.modelID : undefined),
          usageProvenance: provenance,
        })
      }
    }
  }

  return candidates
}

export type ProvenanceFailure = FreeRouteRefusal

export type ProvenanceCapture = {
  requestID: string | null
  requestIDKnown: boolean
  providerID: string
  modelID: string
  cost: { verdict: "FREE" | "UNKNOWN"; status: string; value?: number }
  tokens?: { [key: string]: unknown }
  source: "event" | "message"
}

export type ProvenanceResult =
  | { ok: true; failures: []; capture: ProvenanceCapture }
  | { ok: false; failures: ProvenanceFailure[]; capture?: undefined }

/**
 * Verify the turn's provenance against the pinned free route:
 *  - any candidate naming another provider/model is a fallback (refuse),
 *  - the latest provenance must exist (never invented if absent),
 *  - cost must be FREE (value 0) or UNKNOWN; any nonzero value is paid-route
 *    evidence (refuse),
 *  - the provider request ID is captured when present, recorded as unknown
 *    when absent — never fabricated.
 */
export function evaluateProvenance(input: {
  expected: { providerID: string; modelID: string }
  candidates: readonly ProvenanceCandidate[]
}): ProvenanceResult {
  const failures: ProvenanceFailure[] = []

  for (const candidate of input.candidates) {
    const provider = candidate.providerID
    const model = candidate.modelID
    if (provider !== undefined && provider !== input.expected.providerID) {
      failures.push({
        code: "FALLBACK_DETECTED",
        reason: `a step resolved on ${provider}/${String(model ?? "?")} instead of the pinned ${input.expected.providerID}/${input.expected.modelID}`,
      })
    } else if (model !== undefined && model !== input.expected.modelID) {
      failures.push({
        code: "FALLBACK_DETECTED",
        reason: `a step resolved on ${input.expected.providerID}/${model} instead of the pinned ${input.expected.providerID}/${input.expected.modelID}`,
      })
    }
  }

  const withProvenance = input.candidates.filter((item) => item.usageProvenance !== undefined)
  const latest = withProvenance.at(-1)
  if (latest === undefined || latest.usageProvenance === undefined) {
    failures.push({
      code: "PROVENANCE_MISSING",
      reason: "no usage provenance was captured for the turn (no step-finish or assistant provenance observed); route and cost cannot be verified",
    })
    return { ok: false, failures }
  }

  const provenance = latest.usageProvenance
  const cost = provenance.cost
  let verdict: ProvenanceCapture["cost"]["verdict"]
  if (cost === undefined || cost.status === undefined) {
    failures.push({
      code: "COST_PROVENANCE_MISSING",
      reason: "usage provenance has no cost status; FREE/UNKNOWN cannot be asserted",
    })
    verdict = "UNKNOWN"
  } else if (cost.status === "unknown") {
    verdict = "UNKNOWN"
  } else if (typeof cost.value === "number" && cost.value === 0) {
    verdict = "FREE"
  } else {
    failures.push({
      code: "PAID_COST_EVIDENCE",
      reason: `cost provenance reports ${String(cost.status)} value ${String(cost.value)} — a nonzero cost means the paid route was used, not the free route`,
    })
    verdict = "UNKNOWN"
  }

  if (failures.length > 0) return { ok: false, failures }

  const requestID = typeof provenance.requestID === "string" && provenance.requestID.length > 0 ? provenance.requestID : null
  return {
    ok: true,
    failures: [],
    capture: {
      requestID,
      requestIDKnown: requestID !== null,
      providerID: String(provenance.providerID ?? input.expected.providerID),
      modelID: String(provenance.modelID ?? input.expected.modelID),
      cost: {
        verdict,
        status: String(cost?.status ?? "unknown"),
        ...(typeof cost?.value === "number" ? { value: cost.value } : {}),
      },
      ...(provenance.tokens !== undefined ? { tokens: provenance.tokens } : {}),
      source: latest.source,
    },
  }
}

// ---------------------------------------------------------------------------
// Executable journey (heavy imports stay lazy so tests never boot a server)
// ---------------------------------------------------------------------------

type SmokeArgs = {
  check: boolean
  model?: string
  timeout: number
  task: string
  out?: string
  dir: string
}

const DEFAULT_TASK =
  "Write a function `clamp(v, lo, hi)` that clamps v into [lo, hi], with three short test cases. " +
  "Reply with only the code and the tests. Do not use any tools."

function parseArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = { check: false, timeout: 120_000, task: DEFAULT_TASK, dir: process.cwd() }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--check") args.check = true
    else if (token === "--model") args.model = argv[++index]
    else if (token === "--timeout") args.timeout = Number(argv[++index])
    else if (token === "--task") args.task = argv[++index] ?? args.task
    else if (token === "--out") args.out = argv[++index]
    else if (token === "--dir") args.dir = argv[++index] ?? args.dir
    else if (token === "--help" || token === "-h") {
      process.stdout.write(
        "free-model-smoke [--check] [--model provider/model] [--timeout ms] [--task text] [--out path] [--dir path]\n",
      )
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${token}`)
    }
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("--timeout must be a positive number of ms")
  return args
}

function emit(result: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(exitCode)
}

function refuse(code: string, reason: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`REFUSED [${code}]: ${reason}\n`)
  emit({ verdict: "REFUSED", refusals: [{ code, reason }], ...extra }, 2)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Lazy heavy imports: never loaded when the module is imported by tests.
  const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
  const { HttpRouter } = await import("effect/unstable/http")
  const { memoMap } = await import("@horizoncode/core/effect/memo-map")
  const { disposeMiddleware } = await import("@/server/routes/instance/httpapi/lifecycle")
  const { ServerAuth } = await import("@/server/auth")
  const { Flag } = await import("@horizoncode/core/flag/flag")
  const { createOpencodeClient } = await import("@horizoncode/sdk/v2")

  // In-process server (same wiring as `opencode run` local mode): no port, no
  // socket, instances load per request via the x-opencode-directory header.
  //
  // The route tree is the unmodified production one. The defect this harness
  // previously papered over — handlers/websearch.ts yielding
  // `WebSearchRuntime.Service` at handler-group build time while the app
  // LayerNode group never exposed `WebSearchRuntime.node`, killing
  // `opencode serve`/`Server.Default()` with "Service not found" — was fixed in
  // `src/server/routes/instance/httpapi/server.ts` by adding the node to the app
  // group. No boundary stub is supplied here any more, so this journey fails
  // loudly if that wiring ever regresses instead of hiding it.
  const web = HttpRouter.toWebHandler(HttpApiApp.routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  })

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    const auth = ServerAuth.header()
    if (auth) headers.set("Authorization", auth)
    return web.handler(new Request(request, { headers }), HttpApiApp.context)
  }) as typeof fetch

  const client = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: fetchFn,
    directory: args.dir,
  })

  // ---- Phase 1: local projections (no provider request) -------------------
  const listResult = await client.provider.list().catch((error: unknown) => {
    refuse("PROVIDER_LIST_UNAVAILABLE", `GET /provider failed before any dispatch: ${String(error)}`)
  })
  const configResult = await client.config.get().catch((error: unknown) => {
    refuse("CONFIG_UNAVAILABLE", `GET /config failed before any dispatch: ${String(error)}`)
  })
  const listEnvelope = listResult as { data?: unknown; error?: unknown; response?: { status?: number } }
  if (listEnvelope.error !== undefined && listEnvelope.error !== null) {
    refuse(
      "PROVIDER_LIST_UNAVAILABLE",
      `GET /provider returned an error before any dispatch: ${JSON.stringify(listEnvelope.error)} (status ${String(listEnvelope.response?.status ?? "?")})`,
    )
  }
  const configEnvelope = configResult as { data?: unknown; error?: unknown; response?: { status?: number } }
  if (configEnvelope.error !== undefined && configEnvelope.error !== null) {
    refuse(
      "CONFIG_UNAVAILABLE",
      `GET /config returned an error before any dispatch: ${JSON.stringify(configEnvelope.error)} (status ${String(configEnvelope.response?.status ?? "?")})`,
    )
  }
  const providerList = (listEnvelope.data ?? listResult) as FreeRouteGateInput["providerList"]
  const config = (configEnvelope.data ?? configResult) as FreeRouteGateInput["config"]
  if (!isRecord(providerList) || !Array.isArray((providerList as { all?: unknown }).all ?? undefined) && (providerList as { connected?: unknown }).connected === undefined) {
    refuse(
      "PROVIDER_LIST_UNAVAILABLE",
      `GET /provider returned no recognisable projection before any dispatch: ${JSON.stringify(providerList).slice(0, 400)}`,
    )
  }

  // ---- Phase 2: the free-route gate (fail closed, complete matrix) --------
  const gate = evaluateFreeRouteGate({
    providerList,
    config,
    env: process.env,
    cliModel: args.model,
    ...(args.check ? {} : { serverPasswordConfigured: Flag.OPENCODE_SERVER_PASSWORD !== undefined && Flag.OPENCODE_SERVER_PASSWORD !== "" }),
  })

  if (!gate.ok) {
    for (const refusal of gate.refusals) process.stderr.write(`REFUSED [${refusal.code}]: ${refusal.reason}\n`)
    emit(
      {
        verdict: "REFUSED",
        mode: args.check ? "check" : "turn",
        refusals: gate.refusals,
        providerList: {
          anonymousFreeProviders: providerList.anonymousFreeProviders ?? [],
          anonymousFreeModels: providerList.anonymousFreeModels ?? [],
          connected: providerList.connected ?? [],
          catalogSnapshot: providerList.catalogSnapshot,
        },
      },
      2,
    )
  }

  const plan = gate.plan!

  // ---- Phase 2b: check-only mode stops here, before any session -----------
  if (args.check) {
    emit({ verdict: "PRECONDITIONS_OK", mode: "check", plan, refusals: [] }, 0)
  }

  // ---- Phase 3: one bounded coding turn on the pinned free route ----------
  const events = await client.event.subscribe()
  const stream = events.stream as AsyncIterable<unknown>
  const collected: unknown[] = []
  let providerError: string | undefined
  let rateLimited = false
  let settled: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    settled = resolve
  })

  const deadline = Date.now() + args.timeout
  const consume = (async () => {
    try {
      for await (const event of stream) {
        collected.push(event)
        const record = event as Record<string, unknown>
        if (record.type === "session.error" && isRecord(record.properties) && isRecord(record.properties.error)) {
          const error = record.properties.error as Record<string, unknown>
          providerError = `${String(error.name ?? "Error")}: ${String(error.message ?? "")}`
          if (/429|rate.?limit/i.test(providerError)) rateLimited = true
          settled?.()
          return
        }
        if (
          record.type === "session.status" &&
          isRecord(record.properties) &&
          isRecord(record.properties.status) &&
          record.properties.status.type === "idle"
        ) {
          settled?.()
          return
        }
        if (record.type === "permission.asked" && isRecord(record.properties)) {
          // Deny-all ruleset means nothing should ask; reject defensively.
          await client.permission
            .reply({ requestID: String((record.properties as { id?: unknown }).id ?? ""), reply: "reject" })
            .catch(() => undefined)
        }
        if (Date.now() > deadline) {
          settled?.()
          return
        }
      }
    } catch {
      settled?.()
    }
  })()

  const startedAt = Date.now()
  const session = await client.session.create({
    title: "free-model-smoke",
    // Deny every tool: the bounded task is response-only, so the turn cannot
    // touch the filesystem, run a shell, or leave the repository.
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
  })
  const sessionID = ((session as { data?: { id?: string } }).data ?? (session as { id?: string })).id
  if (!sessionID) refuse("SESSION_CREATE_FAILED", "the smoke session could not be created; nothing was dispatched")

  let promptError: unknown
  try {
    const promptResult = (await client.session.prompt({
      sessionID,
      model: { providerID: plan.route.providerID, modelID: plan.route.modelID },
      parts: [{ type: "text", text: args.task }],
    })) as { data?: unknown; error?: unknown }
    // hey-api returns {error} instead of throwing by default.
    if (promptResult.error !== undefined && promptResult.error !== null) promptError = promptResult.error
  } catch (error) {
    promptError = error
  }

  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), Math.max(deadline - Date.now(), 0))),
  ])
  const elapsedMs = Date.now() - startedAt
  if (timedOut && providerError === undefined && promptError === undefined) {
    emit(
      {
        verdict: "TIMEOUT",
        mode: "turn",
        elapsedMs,
        timeoutMs: args.timeout,
        plan,
        refusals: [],
        note: "the bounded turn did not reach idle before --timeout; no fallback and no retry were attempted",
      },
      5,
    )
  }

  // Bounded drain: the SSE stream may stay open after a prompt error; never
  // await it unbounded (the smoke's own timeout is a hard contract).
  await Promise.race([consume.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))])

  if (promptError !== undefined && providerError === undefined) {
    const message = String((promptError as { message?: unknown }).message ?? promptError)
    const limited = /429|rate.?limit/i.test(message)
    emit(
      {
        verdict: limited ? "RATE_LIMITED" : "PROVIDER_ERROR",
        mode: "turn",
        elapsedMs,
        plan,
        refusals: [],
        error: message,
        note: limited
          ? "provider rate-limited the request: reported honestly as NOT RUN on the same route; no retry, no paid fallback, no second route"
          : "the provider request failed: reported honestly, no paid fallback and no second route were attempted",
      },
      4,
    )
  }
  if (providerError !== undefined) {
    emit(
      {
        verdict: rateLimited ? "RATE_LIMITED" : "PROVIDER_ERROR",
        mode: "turn",
        elapsedMs,
        plan,
        refusals: [],
        error: providerError,
        note: rateLimited
          ? "provider rate-limited the request: reported honestly as NOT RUN on the same route; no retry, no paid fallback, no second route"
          : "the provider rejected the request: reported honestly, no paid fallback and no second route were attempted",
      },
      4,
    )
  }

  // ---- Phase 4: provenance capture (events + persisted messages) ----------
  const messagesResult = await client.session.messages({ sessionID }).catch(() => undefined)
  const payload = (messagesResult as { data?: unknown } | undefined)?.data ?? messagesResult
  const messages = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.messages)
      ? payload.messages
      : isRecord(payload) && Array.isArray(payload.items)
        ? payload.items
        : []

  const candidates = collectProvenanceCandidates({ events: collected, messages })
  const provenance = evaluateProvenance({ expected: { providerID: plan.route.providerID, modelID: plan.route.modelID }, candidates })

  if (!provenance.ok) {
    for (const failure of provenance.failures) process.stderr.write(`PROVENANCE FAILED [${failure.code}]: ${failure.reason}\n`)
    emit(
      {
        verdict: "PROVENANCE_FAILED",
        mode: "turn",
        elapsedMs,
        plan,
        refusals: [],
        failures: provenance.failures,
        candidateCount: candidates.length,
      },
      3,
    )
  }

  const result = {
    verdict: "VERIFIED",
    mode: args.check ? "check" : "turn",
    elapsedMs,
    plan,
    refusals: [],
    sessionID,
    provenance: provenance.capture,
    providerList: {
      anonymousFreeProviders: providerList.anonymousFreeProviders ?? [],
      anonymousFreeModels: providerList.anonymousFreeModels ?? [],
      connected: providerList.connected ?? [],
      catalogSnapshot: providerList.catalogSnapshot,
    },
    task: args.task,
    timestamp: new Date().toISOString(),
  }
  if (args.out !== undefined) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n", "utf8")
  }
  emit(result, 0)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`SMOKE ERROR: ${String((error as { stack?: unknown }).stack ?? error)}\n`)
    process.exit(1)
  })
}
