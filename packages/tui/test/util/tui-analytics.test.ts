import { describe, expect, test } from "bun:test"
import type { SvgRasterObservationV1 } from "../../src/util/artifact-render"
import { createTuiArtifactRenderer } from "../../src/util/artifact-render"
import { createTuiAnalyticsProjection, formatTuiObservation, tuiAnalyticsProjection } from "../../src/util/tui-analytics"

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
      value: "0 bytes, unknown via ui-event-mux, unknown freshness",
    })
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
        value: 500,
        unit: "entries",
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
    ] as unknown as SvgRasterObservationV1[])

    const snapshot = projection.snapshot()
    expect(snapshot).toHaveLength(6)
    expect(snapshot.map(({ metric, value }) => [metric, value])).toEqual([
      ["ui.artifact.render_full", 3],
      ["ui.artifact.render_sample", 1],
      ["ui.artifact.render_failed", 1],
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
    ] as unknown as SvgRasterObservationV1[])

    expect(projection.snapshot().find((item) => item.metric === "ui.artifact.render_full")?.value).toBe(3)
    expect(projection.snapshot().length).toBe(6)
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

    expect(projection.snapshot()).toHaveLength(6)
    expect(projection.snapshot()[0]?.value).toBe(16 * 7)
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
