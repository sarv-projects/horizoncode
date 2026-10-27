import { describe, expect, test } from "bun:test"
import type { SvgRasterObservationV1 } from "../../src/util/artifact-render"
import { createTuiArtifactRenderer } from "../../src/util/artifact-render"
import { createTuiAnalyticsProjection, formatTuiObservation, projectSessionUsage, tuiAnalyticsProjection,
  buildDiagnosticExport,
  DIAGNOSTIC_EXPORT_MAX_BYTES,
} from "../../src/util/tui-analytics"

describe("TUI analytics projection", () => {
  test("formats content-free stream metrics with provenance and freshness", () => {
    expect(formatTuiObservation({
        metric: "ui.stream.duplicates_suppressed",
        value: 3,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
        observedAtMs: 1_000,
        content: "must not be surfaced",
      } as never, 2_500)).toEqual({
        label: "Stream duplicates suppressed",
        value: "3 events, measured via ui-event-mux, 1s old",
      })
    expect(formatTuiObservation({
      metric: "ui.queue.pending_bytes",
      value: 0,
      unit: "bytes",
      provenance: "unknown",
      source: "ui-event-mux",
      observedAtMs: undefined,
    } as never, 2_500)).toEqual({
      label: "Queue pending bytes",
      value: "unknown, unknown via ui-event-mux, unknown freshness",
    })
    expect(formatTuiObservation({
      metric: "ui.queue.pending_bytes",
      value: 512,
      unit: "bytes",
      provenance: "unknown",
      source: "ui-event-mux",
      observedAtMs: 2_000,
    }, 2_500)).toEqual({
      label: "Queue pending bytes",
      value: "unknown, unknown via ui-event-mux, 0s old",
    })
  })

  test("does not render malformed metric values or attacker-controlled labels", () => {
    expect(formatTuiObservation({
      metric: "ui.stream.duplicates_suppressed\u001b[31msecret",
      value: 7,
      unit: "events",
      provenance: "measured",
      source: "ui-event-mux",
      observedAtMs: 1_000,
    }, 2_000)).toEqual({ label: "Metric unavailable", value: "unknown, unknown, unknown freshness" })

    expect(formatTuiObservation({
      metric: "ui.queue.pending_bytes",
      value: Number.NaN,
      unit: "bytes",
      provenance: "measured",
      source: "ui-event-mux",
      observedAtMs: 1_000,
    }, 2_000)).toEqual({ label: "Queue pending bytes", value: "unknown, unknown, unknown freshness" })
  })

  test("does not format non-finite clocks as metric freshness", () => {
    expect(formatTuiObservation({
      metric: "ui.queue.pending_bytes",
      value: 12,
      unit: "bytes",
      provenance: "measured",
      source: "ui-event-mux",
      observedAtMs: 1_000,
    }, Number.POSITIVE_INFINITY)).toEqual({
      label: "Queue pending bytes",
      value: "12 bytes, measured via ui-event-mux, unknown freshness",
    })
  })

  test("projects only canonical assistant usage provenance and leaves legacy scalars unknown", () => {
    const usage = projectSessionUsage([
      {
        role: "assistant",
        providerID: "legacy-provider",
        modelID: "legacy-model",
        cost: 999,
        tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } },
      },
      {
        role: "assistant",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        usageProvenance: {
          providerID: "opencode",
          modelID: "nemotron/free",
          requestID: "request-42",
          cost: { status: "provider-reported", value: 0 },
          tokens: {
            input: { status: "provider-reported", value: 12 },
            output: { status: "provider-reported", value: 4 },
            reasoning: { status: "unknown" },
            cache: {
              read: { status: "unknown", value: 0 },
              write: { status: "provider-reported", value: 3 },
            },
          },
        },
      },
    ])

    expect(usage[0]).toBe("Recent usage (last 2 Session messages): 2 assistant messages · 2 provider steps/records · 1 provenance record · 1 unknown")
    expect(usage[1]).toContain("opencode/nemotron/free · request request-42")
    expect(usage[1]).toContain("in provider-reported:12")
    expect(usage[1]).toContain("reasoning unknown")
    expect(usage[1]).toContain("cache read unknown")
    expect(usage[1]).toContain("cache write provider-reported:3")
    expect(usage[1]).toContain("cost provider-reported:0")
    expect(usage.find((row) => row.startsWith("Token totals"))).toContain("Input: provider-reported 12 + unknown 1")
    expect(usage.find((row) => row.startsWith("Token totals"))).toContain("Output: provider-reported 4 + unknown 1")
    expect(usage.find((row) => row.startsWith("Token totals"))).toContain("Reasoning: unknown 2")
    expect(usage.find((row) => row.startsWith("Token totals"))).toContain("Cache write: provider-reported 3 + unknown 1")
    expect(usage.find((row) => row.startsWith("Cost observations"))).toContain("provider-reported 1 · estimated 0 · measured 0 · unknown 1")
    expect(usage.find((row) => row.startsWith("Cost observations"))).toContain("no cross-route sum")
    expect(usage.join("\n")).not.toContain("999")
  })

  test("counts assistant-level and per-step provenance once each (AN-001)", () => {
    const step = (index: number, input: number) => ({
      type: "step-finish",
      stepFinishIndex: index,
      usageProvenance: {
        providerID: "test",
        modelID: "model",
        requestID: `request-${index}`,
        cost: { status: "provider-reported", value: 0 },
        tokens: {
          input: { status: "provider-reported", value: input },
          output: { status: "provider-reported", value: 1 },
          reasoning: { status: "provider-reported", value: 0 },
          cache: {
            read: { status: "provider-reported", value: 0 },
            write: { status: "provider-reported", value: 0 },
          },
        },
      },
    })
    const rows = projectSessionUsage(
      [
        {
          id: "msg_1",
          role: "assistant",
          // The assistant-level record repeats the last step's usage in older
          // projections; it must never be added on top of the step receipts.
          usageProvenance: {
            providerID: "test",
            modelID: "model",
            requestID: "request-1",
            cost: { status: "provider-reported", value: 0 },
            tokens: {
              input: { status: "provider-reported", value: 10 },
              output: { status: "provider-reported", value: 1 },
              reasoning: { status: "provider-reported", value: 0 },
              cache: {
                read: { status: "provider-reported", value: 0 },
                write: { status: "provider-reported", value: 0 },
              },
            },
          },
        },
      ],
      8,
      { msg_1: [step(0, 10), step(1, 20)] },
    )

    expect(rows[0]).toBe(
      "Recent usage (last 1 Session messages): 1 assistant messages · 2 provider steps/records · 2 provenance records · 0 unknown",
    )
    const totals = rows.find((row) => row.startsWith("Token totals"))!
    // 10 (step 0) + 20 (step 1); the assistant-level duplicate must not add 10 again.
    expect(totals).toContain("Input: provider-reported 30")
    expect(totals).not.toContain("Input: unknown")
    // A bucket every step reported as provider-reported zero is *known* zero;
    // §31.19 forbids relabelling it as unknown provenance.
    expect(totals).toContain("Reasoning: provider-reported 0")
    expect(totals).not.toContain("Reasoning: unknown")
    expect(totals).toContain("Cache read: provider-reported 0")
    expect(rows.filter((row) => row.includes("· step "))).toHaveLength(2)
  })

  test("reports an absent provider price as unknown and never as zero (AN-002)", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          tokens: {
            input: { status: "provider-reported", value: 3 },
            output: { status: "provider-reported", value: 2 },
            reasoning: { status: "provider-reported", value: 0 },
            cache: {
              read: { status: "provider-reported", value: 0 },
              write: { status: "provider-reported", value: 0 },
            },
          },
          // No `cost` at all: the provider reported none.
        },
      },
    ])

    expect(rows[1]).toContain("cost unknown")
    expect(rows[1]).not.toContain("cost 0")
    expect(rows[1]).not.toContain("cost provider-reported:0")
    expect(rows[1]).not.toContain("cost estimated")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain(
      "provider-reported 0 · estimated 0 · measured 0 · unknown 1",
    )
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("no cross-route sum")
  })

  test("never projects raw prompt, tool output or secret material into usage rows (AN-007)", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        text: "raw prompt with SUPERSECRET raw prompt text",
        parts: [{ type: "tool", state: { output: "raw tool output with SUPERSECRET" } }],
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          requestID: "request-1",
          cost: { status: "provider-reported", value: 0 },
          tokens: {
            input: { status: "provider-reported", value: 1 },
            output: { status: "provider-reported", value: 1 },
            reasoning: { status: "provider-reported", value: 0 },
            cache: {
              read: { status: "provider-reported", value: 0 },
              write: { status: "provider-reported", value: 0 },
            },
          },
        },
      },
    ])

    const exported = rows.join("\n")
    expect(exported).not.toContain("SUPERSECRET")
    expect(exported).not.toContain("raw tool output")
    expect(exported).not.toContain("raw prompt")
    expect(exported).toContain("test/model")
  })

  test("validates diagnostic export shape and strips control-bearing labels (AN-007)", () => {
    const exported = buildDiagnosticExport([
      { label: "Version", value: "1.2.3" },
      { label: "Usage\u001b[31m", value: "red" },
      { label: "Session ID", value: "ses_ok" },
      "not-an-entry" as never,
      { label: 42 as never, value: "bad" },
      { label: "No value" } as never,
    ])

    expect(exported).toContain("Version: 1.2.3")
    expect(exported).toContain("Session ID: ses_ok")
    // The whole ANSI escape sequence is removed, not just its introducer.
    expect(exported).toContain("Usage: red")
    expect(exported).not.toContain("[31m")
    expect(exported).not.toContain("\u001b")
    expect(exported).not.toContain("not-an-entry")
    expect(exported).not.toContain("bad")
    expect(exported).not.toContain("No value")
  })

  test("bounds the diagnostic export payload and labels the truncation (AN-007)", () => {
    const bulky = Array.from({ length: 200 }, (_, index) => ({
      label: `Row${index}`,
      value: "x".repeat(512),
    }))
    const exported = buildDiagnosticExport(bulky)

    expect(Buffer.byteLength(exported, "utf8")).toBeLessThanOrEqual(DIAGNOSTIC_EXPORT_MAX_BYTES)
    expect(exported).toContain("[diagnostic export truncated")
    expect(exported).toContain("Row0: ")
  })

  test("bounds one oversized diagnostic row instead of emitting it whole (AN-007)", () => {
    const exported = buildDiagnosticExport([
      { label: "Huge", value: "y".repeat(64 * 1024) },
      { label: "Tail", value: "kept" },
    ])

    expect(Buffer.byteLength(exported, "utf8")).toBeLessThanOrEqual(DIAGNOSTIC_EXPORT_MAX_BYTES)
    expect(exported).toContain("Tail: kept")
  })

  test("never invents a monetary cost for a local-model usage record (AN-003)", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "ollama",
          modelID: "local-model",
          requestID: "request-local",
          cost: { status: "unknown" },
          tokens: {
            input: { status: "provider-reported", value: 5 },
            output: { status: "provider-reported", value: 7 },
            reasoning: { status: "provider-reported", value: 0 },
            cache: {
              read: { status: "provider-reported", value: 0 },
              write: { status: "provider-reported", value: 0 },
            },
          },
        },
      },
      {
        // Legacy scalar path: a bare `cost: 0` must never become a free-model
        // monetary claim when no declared cost policy backs it.
        role: "assistant",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])

    // Rows are emitted newest-first; the legacy scalar record has no provenance.
    const local = rows.find((row) => row.includes("ollama/local-model"))!
    expect(local).toBeDefined()
    expect(local).toContain("cost unknown")
    expect(local).not.toContain("cost 0")
    expect(local).not.toContain("cost measured")
    expect(rows.find((row) => row.startsWith("Usage unavailable"))).toContain("usage provenance unavailable")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain(
      "provider-reported 0 · estimated 0 · measured 0 · unknown 2",
    )
    expect(rows.join("\n")).not.toContain("free")
  })

  test("counts nested/child tool usage at most once in the parent totals (AN-004)", () => {
    const nestedUsage = {
      providerID: "test",
      modelID: "child-model",
      requestID: "request-child",
      cost: { status: "provider-reported", value: 0 },
      tokens: {
        input: { status: "provider-reported", value: 100 },
        output: { status: "provider-reported", value: 50 },
        reasoning: { status: "provider-reported", value: 0 },
        cache: {
          read: { status: "provider-reported", value: 0 },
          write: { status: "provider-reported", value: 0 },
        },
      },
    }
    const rows = projectSessionUsage(
      [{ id: "msg_1", role: "assistant", usageProvenance: { ...nestedUsage, requestID: "request-parent" } }],
      8,
      // A nested/subagent tool result carries its own usage; it is not an
      // assistant usage receipt and must not be summed into the parent again.
      { msg_1: [{ type: "tool", tool: "task", state: { usageProvenance: nestedUsage } }] },
    )

    expect(rows[0]).toBe(
      "Recent usage (last 1 Session messages): 1 assistant messages · 1 provider steps/records · 1 provenance record · 0 unknown",
    )
    const totals = rows.find((row) => row.startsWith("Token totals"))!
    expect(totals).toContain("Input: provider-reported 100")
    expect(totals).not.toContain("200")
    expect(totals).not.toContain("150")
    expect(totals).toContain("Output: provider-reported 50")
  })

  test("bounds usage projection to the latest 256 session messages", () => {
    const messages = [
      { role: "assistant", usageProvenance: { providerID: "old-provider", modelID: "old-model", tokens: { cache: {} } } },
      ...Array.from({ length: 256 }, () => ({ role: "user" })),
    ]
    const rows = projectSessionUsage(messages)
    expect(rows[0]).toBe("Recent usage (last 256 Session messages): 0 assistant messages · 0 provider steps/records · 0 provenance records · 0 unknown")
    expect(rows.join("\n")).not.toContain("old-provider")
  })

  test("ignores inherited part-map properties for special message IDs", () => {
    const rows = projectSessionUsage(
      [{ id: "toString", role: "assistant" }],
      8,
      {},
    )
    expect(rows[0]).toBe("Recent usage (last 1 Session messages): 1 assistant messages · 1 provider steps/records · 0 provenance records · 1 unknown")
    expect(rows[1]).toContain("Usage unavailable · usage provenance unavailable")
  })

  test("ignores accessor-backed part-map entries without evaluating them", () => {
    const partsByMessage: Record<string, unknown> = {}
    Object.defineProperty(partsByMessage, "message-1", {
      enumerable: true,
      get() {
        throw new Error("analytics must not evaluate part-map accessors")
      },
    })

    const rows = projectSessionUsage(
      [{ id: "message-1", role: "assistant" }],
      8,
      partsByMessage as Record<string, readonly unknown[]>,
    )

    expect(rows[0]).toBe("Recent usage (last 1 Session messages): 1 assistant messages · 1 provider steps/records · 0 provenance records · 1 unknown")
    expect(rows[1]).toContain("Usage unavailable · usage provenance unavailable")
  })

  test("treats accessor-backed token metric fields as unknown", () => {
    const input = {
      role: "assistant",
      usageProvenance: {
        providerID: "test",
        modelID: "model",
        requestID: "request-1",
        tokens: {
          get input() {
            throw new Error("analytics must not evaluate token metric accessors")
          },
          output: { status: "provider-reported", value: 3 },
          reasoning: { status: "unknown" },
          cache: { read: { status: "unknown" }, write: { status: "unknown" } },
        },
      },
    }

    const rows = projectSessionUsage([input])

    expect(rows[1]).toContain("in unknown")
    expect(rows.find((row) => row.startsWith("Token totals"))).toContain("Input: unknown 1")
  })

  test("treats accessor-backed cost fields as unknown", () => {
    const rows = projectSessionUsage([{
      role: "assistant",
      usageProvenance: {
        providerID: "test",
        modelID: "model",
        requestID: "request-1",
        cost: {
          get status() {
            throw new Error("analytics must not evaluate cost accessors")
          },
          value: 12,
        },
        tokens: {
          input: { status: "unknown" },
          output: { status: "unknown" },
          reasoning: { status: "unknown" },
          cache: { read: { status: "unknown" }, write: { status: "unknown" } },
        },
      },
    }])

    expect(rows[1]).toContain("cost unknown")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("unknown 1")
  })

  test("treats revoked cost records as unknown", () => {
    const revoked = Proxy.revocable({ status: "provider-reported", value: 12 }, {})
    revoked.revoke()
    const rows = projectSessionUsage([{
      role: "assistant",
      usageProvenance: {
        providerID: "test",
        modelID: "model",
        requestID: "request-1",
        cost: revoked.proxy,
        tokens: {
          input: { status: "unknown" },
          output: { status: "unknown" },
          reasoning: { status: "unknown" },
          cache: { read: { status: "unknown" }, write: { status: "unknown" } },
        },
      },
    }])

    expect(rows[1]).toContain("cost unknown")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("unknown 1")
  })

  test("treats revoked message-part arrays as unavailable", () => {
    const revoked = Proxy.revocable([{ type: "step-finish" }], {})
    revoked.revoke()
    const rows = projectSessionUsage(
      [{ id: "message-1", role: "assistant" }],
      8,
      { "message-1": revoked.proxy } as unknown as Record<string, readonly unknown[]>,
    )

    expect(rows[0]).toContain("1 provider steps/records · 0 provenance records · 1 unknown")
    expect(rows[1]).toContain("Usage unavailable · usage provenance unavailable")
  })

  test("does not evaluate accessors on message-part records", () => {
    const part = Object.defineProperty({}, "type", {
      get() {
        throw new Error("part type accessor must not run")
      },
    })
    const rows = projectSessionUsage(
      [{ id: "message-1", role: "assistant" }],
      8,
      { "message-1": [part] },
    )

    expect(rows[0]).toContain("1 provider steps/records · 0 provenance records · 1 unknown")
    expect(rows[1]).toContain("Usage unavailable · usage provenance unavailable")
  })

  test("requires complete pricing and billing provenance before showing a cost value", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          cost: { status: "measured", value: 7 },
          tokens: {
            input: { status: "unknown" },
            output: { status: "unknown" },
            reasoning: { status: "unknown" },
            cache: { read: { status: "unknown" }, write: { status: "unknown" } },
          },
        },
      },
    ])
    expect(rows[1]).toContain("cost unknown")
    expect(rows[1]).not.toContain("measured:7")
  })

  test("labels catalog-derived cost as estimated and retains its pricing source", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          requestID: "request-1",
          cost: {
            status: "estimated",
            value: 0,
            priceSource: "selected-model-catalog",
            pricingRevision: `sha256:${"a".repeat(64)}`,
            pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            algorithm: "per-million-linear-v1",
            tokenInputs: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          tokens: {
            input: { status: "provider-reported", value: 1 },
            output: { status: "provider-reported", value: 1 },
            reasoning: { status: "provider-reported", value: 0 },
            cache: {
              read: { status: "provider-reported", value: 0 },
              write: { status: "provider-reported", value: 0 },
            },
          },
        },
      },
    ])
    expect(rows[1]).toContain("cost estimated:0 via selected-model-catalog")
    expect(rows[1]).not.toContain("cost measured:")
  })

  test("aggregates only bounded content-free measured artifact counters with freshness", () => {
    let now = 1_000
    const projection = createTuiAnalyticsProjection(() => now)
    const reporter = projection.attachArtifactRenderer()

    reporter.observe([
      {
        metric: "ui.artifact.render_full",
        value: 2,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.render_sample",
        value: 1,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.render_failed",
        value: 0,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_requests",
        value: 4,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_completed",
        value: 3,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_failed",
        value: 1,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_cache_entries",
        value: 2,
        unit: "entries",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_cache_bytes",
        value: 500,
        unit: "bytes",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.render_full",
        value: 900,
        unit: "renders",
        provenance: "measured",
        source: "untrusted:secret-token",
        observedAtMs: now,
        content: "secret",
      },
      {
        metric: "ui.artifact.render_full",
        value: 900,
        unit: "renders",
        provenance: "estimated",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
    ] as unknown as SvgRasterObservationV1[])

    now = 2_000
    reporter.observe([
      {
        metric: "ui.artifact.render_full",
        value: 3,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.render_sample",
        value: 1,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.render_failed",
        value: 1,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_requests",
        value: 5,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_cache_entries",
        value: 3,
        unit: "entries",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_cache_bytes",
        value: 400,
        unit: "bytes",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_completed",
        value: 4,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_failed",
        value: 1,
        unit: "events",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: now,
      },
      {
        metric: "ui.artifact.raster_cache_bytes",
        value: 800,
        unit: "bytes",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: 1_500,
      },
    ] as unknown as SvgRasterObservationV1[])

    const snapshot = projection.snapshot()
    expect(snapshot).toHaveLength(8)
    expect(snapshot.map(({ metric, value }) => [metric, value])).toEqual([
      ["ui.artifact.render_full", 3],
      ["ui.artifact.render_sample", 1],
      ["ui.artifact.render_failed", 1],
      ["ui.artifact.raster_cache_entries", 3],
      ["ui.artifact.raster_cache_bytes", 400],
      ["ui.artifact.raster_requests", 5],
      ["ui.artifact.raster_completed", 4],
      ["ui.artifact.raster_failed", 1],
    ])
    expect(snapshot.every((item) => item.provenance === "measured" && item.observedAtMs === now)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain("secret")
    expect(JSON.stringify(snapshot)).not.toContain("content")
  })

  test("keeps lifetime aggregates bounded when a renderer is disposed", () => {
    const projection = createTuiAnalyticsProjection(() => 3_000)
    const first = projection.attachArtifactRenderer()
    first.observe([
      {
        metric: "ui.artifact.render_full",
        value: 2,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: 3_000,
      },
      {
        metric: "ui.artifact.raster_cache_entries",
        value: 3,
        unit: "entries",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: 3_000,
      },
      {
        metric: "ui.artifact.raster_cache_bytes",
        value: 100,
        unit: "bytes",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: 3_000,
      },
    ] as unknown as SvgRasterObservationV1[])
    first.dispose()

    const second = projection.attachArtifactRenderer()
    second.observe([
      {
        metric: "ui.artifact.render_full",
        value: 1,
        unit: "renders",
        provenance: "measured",
        source: "tui-artifact-renderer",
        observedAtMs: 3_000,
      },
      {
        metric: "ui.artifact.raster_cache_entries",
        value: 1,
        unit: "entries",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: 3_000,
      },
      {
        metric: "ui.artifact.raster_cache_bytes",
        value: 20,
        unit: "bytes",
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs: 3_000,
      },
    ] as unknown as SvgRasterObservationV1[])

    expect(projection.snapshot().find((item) => item.metric === "ui.artifact.render_full")?.value).toBe(3)
    expect(projection.snapshot().length).toBe(8)
    expect(projection.snapshot().find((item) => item.metric === "ui.artifact.raster_cache_entries")?.value).toBe(1)
    expect(projection.snapshot().find((item) => item.metric === "ui.artifact.raster_cache_bytes")?.value).toBe(20)
  })

  test("bounds active renderer reporters and observations per report", () => {
    const projection = createTuiAnalyticsProjection(() => 4_000)
    const reporters = Array.from({ length: 17 }, () => projection.attachArtifactRenderer())
    const input = Array.from({ length: 10_000 }, (_, index) => ({
      metric: "ui.artifact.render_full",
      value: index + 1,
      unit: "renders",
      provenance: "measured",
      source: "tui-artifact-renderer",
      observedAtMs: 4_000,
    }))
    for (const reporter of reporters) reporter.observe(input as unknown as SvgRasterObservationV1[])

    expect(projection.snapshot()).toHaveLength(8)
    expect(projection.snapshot()[0]?.value).toBe(16 * 8)
    reporters.forEach((reporter) => reporter.dispose())
  })

  test("projects actual artifact renderer results into the process diagnostics snapshot", () => {
    const before = tuiAnalyticsProjection.snapshot().find((item) => item.metric === "ui.artifact.render_full")!
    const renderer = createTuiArtifactRenderer()
    try {
      renderer.render("plain content", true)
      const after = tuiAnalyticsProjection.snapshot().find((item) => item.metric === "ui.artifact.render_full")!
      expect(after.value).toBe(before.value + 1)
      expect(after.provenance).toBe("measured")
      expect(after.source).toBe("tui-artifact-renderer")
    } finally {
      renderer.dispose()
    }
  })

  test("bounds the usage detail rows to the requested row limit (AN-008 retention)", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "assistant",
      usageProvenance: {
        providerID: "test",
        modelID: "model",
        requestID: `request-${index}`,
        tokens: {
          input: { status: "provider-reported", value: 1 },
          output: { status: "provider-reported", value: 1 },
          reasoning: { status: "unknown" },
          cache: { read: { status: "unknown" }, write: { status: "unknown" } },
        },
      },
    }))

    const rows = projectSessionUsage(messages, 2)
    // Header + two detail rows + the two aggregate rows; the remaining eight
    // observations are counted but never materialized as rows.
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain("10 provider steps/records")
    expect(rows[0]).toContain("10 provenance records")
    expect(rows.slice(1, 3).every((row) => row.startsWith("test/model"))).toBe(true)
    expect(rows[3]?.startsWith("Token totals")).toBe(true)

    const none = projectSessionUsage(messages, 0)
    expect(none).toHaveLength(3)
    expect(none[0]).toContain("10 provenance records")
    expect(none[1]?.startsWith("Token totals")).toBe(true)
    expect(none.join("\n")).not.toContain("request-0")
  })

  test("keeps a provider-reported cost unknown when the response carries no request identity (AN-007)", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          cost: { status: "provider-reported", value: 7 },
          tokens: {
            input: { status: "provider-reported", value: 3 },
            output: { status: "provider-reported", value: 2 },
            reasoning: { status: "unknown" },
            cache: { read: { status: "unknown" }, write: { status: "unknown" } },
          },
        },
      },
    ])

    expect(rows[1]).toContain("cost unknown")
    expect(rows[1]).toContain("request unknown")
    // The unattributed value must not appear anywhere in the exported panel,
    // neither in the detail row nor in either aggregate row.
    expect(rows.join("\n")).not.toContain("7")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("provider-reported 0")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("unknown 1")
  })

  test("does not use an operation ID as a substitute for the provider request ID (AN-007)", () => {
    const rows = projectSessionUsage([
      {
        role: "assistant",
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          operationID: "operation-1",
          cost: { status: "provider-reported", value: 7 },
          tokens: {
            input: { status: "provider-reported", value: 3 },
            output: { status: "provider-reported", value: 2 },
            reasoning: { status: "unknown" },
            cache: { read: { status: "unknown" }, write: { status: "unknown" } },
          },
        },
      },
    ])

    expect(rows[1]).toContain("operation operation-1")
    expect(rows[1]).toContain("cost unknown")
    expect(rows.join("\n")).not.toContain("provider-reported:7")
    expect(rows.find((row) => row.startsWith("Cost observations"))).toContain("unknown 1")
  })

  test("bounds the bounded usage scan and reports truncation instead of fabricating attribution", () => {
    const messages: unknown[] = []
    const partsByMessage: Record<string, unknown[]> = {}
    for (let index = 0; index < 256; index++) {
      const messageID = `m${index}`
      messages.push({ id: messageID, role: "assistant" })
      partsByMessage[messageID] = Array.from({ length: 40 }, (_, step) => ({
        type: "step-finish",
        stepFinishIndex: step,
        usageProvenance: {
          providerID: "test",
          modelID: "model",
          requestID: `request-${index}-${step}`,
          tokens: {
            input: { status: "provider-reported", value: 1 },
            output: { status: "provider-reported", value: 1 },
            reasoning: { status: "unknown" },
            cache: { read: { status: "unknown" }, write: { status: "unknown" } },
          },
        },
      }))
    }

    const rows = projectSessionUsage(messages, 8, partsByMessage)
    // 256 messages × 40 step receipts far exceed the 8,192-part scan budget:
    // exactly the budget is attributed and nothing beyond it is invented.
    expect(rows[0]).toContain("8192 provenance records")
    expect(rows[0]).toContain("103 unknown")
    expect(rows[0]).toContain("8295 provider steps/records")

    // Every visible detail row belongs to an unscanned tail message and must
    // say so rather than presenting fabricated usage for it.
    const detailRows = rows.slice(1, 9)
    expect(detailRows).toHaveLength(8)
    for (const row of detailRows) {
      expect(
        row.includes("usage history exceeded the bounded analytics scan") ||
          row.includes("usage provenance unavailable"),
      ).toBe(true)
      expect(row).not.toContain("request-")
    }
    expect(detailRows.some((row) => row.includes("bounded analytics scan"))).toBe(true)
  })

  test("filters malformed counter observations even when they lead the bounded report", () => {
    let now = 1_000
    const projection = createTuiAnalyticsProjection(() => now)
    const reporter = projection.attachArtifactRenderer()
    const valid = {
      metric: "ui.artifact.render_full",
      value: 2,
      unit: "renders",
      provenance: "measured",
      source: "tui-artifact-renderer",
      observedAtMs: now,
    }
    // Only the first MAX_OBSERVATIONS_PER_REPORT (8) entries of a report are
    // examined, so the malformed rows are placed first: they must be rejected
    // by the allowlist itself, not skipped by the cap.
    reporter.observe([
      { ...valid, source: "untrusted:secret-token", value: 900, content: "secret" },
      { ...valid, provenance: "estimated", value: 900 },
      { ...valid, unit: "events", value: 900 },
      { ...valid, observedAtMs: now + 10_000, value: 900 },
      { ...valid, metric: "ui.artifact.unknown_metric", value: 900 },
      valid,
    ] as unknown as SvgRasterObservationV1[])

    now = 2_000
    const snapshot = projection.snapshot()
    expect(snapshot.find((item) => item.metric === "ui.artifact.render_full")).toMatchObject({
      value: 2,
      provenance: "measured",
      source: "tui-artifact-renderer",
      observedAtMs: 1_000,
    })
    expect(snapshot).toHaveLength(8)
    expect(snapshot.filter((item) => item.provenance === "measured")).toHaveLength(1)
    expect(JSON.stringify(snapshot)).not.toContain("secret")
    expect(JSON.stringify(snapshot)).not.toContain("untrusted")
    reporter.dispose()
  })
})
