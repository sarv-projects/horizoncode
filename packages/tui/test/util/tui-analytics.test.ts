import { describe, expect, test } from "bun:test"
import type { SvgRasterObservationV1 } from "../../src/util/artifact-render"
import { createTuiArtifactRenderer } from "../../src/util/artifact-render"
import { createTuiAnalyticsProjection, formatTuiObservation, projectSessionUsage, tuiAnalyticsProjection } from "../../src/util/tui-analytics"

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

  test("bounds usage projection to the latest 256 session messages", () => {
    const messages = [
      { role: "assistant", usageProvenance: { providerID: "old-provider", modelID: "old-model", tokens: { cache: {} } } },
      ...Array.from({ length: 256 }, () => ({ role: "user" })),
    ]
    const rows = projectSessionUsage(messages)
    expect(rows[0]).toBe("Recent usage (last 256 Session messages): 0 assistant messages · 0 provider steps/records · 0 provenance records · 0 unknown")
    expect(rows.join("\n")).not.toContain("old-provider")
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
})
