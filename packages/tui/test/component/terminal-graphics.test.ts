import { expect, test } from "bun:test"
import {
  createTerminalGraphicsSurface,
  negotiateTerminalGraphics,
} from "../../src/component/terminal-graphics"

test("never assumes a graphics protocol from a terminal name alone", () => {
  for (const terminalName of ["xterm-kitty", "wezterm", "foot", "iTerm2", "sixel-terminal"]) {
    const negotiation = negotiateTerminalGraphics({ terminalName })
    expect(negotiation).toEqual({
      protocol: "none",
      transmitOnce: false,
      reason: "no_explicit_protocol_evidence",
    })
  }
})

test("uses only explicit protocol evidence and honors an explicit opt-out", () => {
  expect(negotiateTerminalGraphics({ reportedProtocols: ["kitty"] })).toEqual({
    protocol: "kitty",
    transmitOnce: true,
    reason: "explicit_protocol_report",
  })
  expect(negotiateTerminalGraphics({ reportedProtocols: ["sixel"], terminalName: "xterm-kitty" })).toEqual({
    protocol: "sixel",
    transmitOnce: false,
    reason: "explicit_protocol_report",
  })
  expect(negotiateTerminalGraphics({ reportedProtocols: ["unknown-graphics"], terminalName: "xterm-kitty" })).toEqual({
    protocol: "none",
    transmitOnce: false,
    reason: "no_explicit_protocol_evidence",
  })
  expect(negotiateTerminalGraphics({ reportedProtocols: ["kitty"], disabled: true })).toEqual({
    protocol: "none",
    transmitOnce: false,
    reason: "disabled",
  })
})

test("falls back to text for every placement on an unknown graphics protocol", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ terminalName: "xterm-kitty" }),
  })
  const decision = surface.place({ imageID: "img-1", generation: "gen-1", bytes: 1_024, rows: 4 })
  expect(decision).toEqual({ status: "fallback", imageID: "img-1", reason: "unsupported_protocol" })
  expect(surface.plan()).toEqual({ images: 0, bytes: 0, rows: 0 })
  expect(surface.stats().fallbacks).toBe(1)
})

test("bounds placed images, bytes and reserved rows with explicit fallbacks", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ reportedProtocols: ["kitty"] }),
    maxImages: 2,
    maxImageBytes: 1_000,
    maxTotalBytes: 1_500,
    maxReservedRows: 6,
    viewportRows: 20,
  })

  expect(surface.place({ imageID: "a", generation: "g1", bytes: 600, rows: 2 })).toMatchObject({ status: "placed" })
  expect(surface.place({ imageID: "b", generation: "g1", bytes: 600, rows: 2 })).toMatchObject({ status: "placed" })
  // Third image evicts the oldest bounded entry instead of growing unbounded.
  expect(surface.place({ imageID: "c", generation: "g1", bytes: 600, rows: 2 })).toMatchObject({ status: "placed" })
  expect(surface.plan()).toEqual({ images: 2, bytes: 1_200, rows: 4 })
  expect(surface.stats().purged).toBe(1)

  // Per-image byte budget reports an explicit fallback without evicting.
  expect(surface.place({ imageID: "d", generation: "g1", bytes: 1_001, rows: 1 })).toEqual({
    status: "fallback",
    imageID: "d",
    reason: "byte_budget",
  })
  expect(surface.plan()).toEqual({ images: 2, bytes: 1_200, rows: 4 })

  // Aggregate byte and row budgets fall back instead of exceeding the surface.
  expect(surface.place({ imageID: "d", generation: "g1", bytes: 1_000, rows: 1 })).toEqual({
    status: "fallback",
    imageID: "d",
    reason: "byte_budget",
  })
  expect(surface.place({ imageID: "d", generation: "g1", bytes: 400, rows: 5 })).toEqual({
    status: "fallback",
    imageID: "d",
    reason: "row_budget",
  })
  expect(surface.plan().rows).toBeLessThanOrEqual(6)
  expect(surface.plan().bytes).toBeLessThanOrEqual(1_500)
})

test("rejecting an over-budget placement does not evict an existing image", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ reportedProtocols: ["kitty"] }),
    maxImages: 3,
    maxImageBytes: 1_000,
    maxTotalBytes: 1_000,
    maxReservedRows: 10,
    viewportRows: 20,
  })
  surface.place({ imageID: "small", generation: "g1", bytes: 100, rows: 1 })
  surface.place({ imageID: "medium-1", generation: "g1", bytes: 450, rows: 1 })
  surface.place({ imageID: "medium-2", generation: "g1", bytes: 450, rows: 1 })

  expect(surface.place({ imageID: "too-large-for-current-budget", generation: "g1", bytes: 600, rows: 1 })).toEqual({
    status: "fallback",
    imageID: "too-large-for-current-budget",
    reason: "byte_budget",
  })
  expect(surface.plan()).toEqual({ images: 3, bytes: 1_000, rows: 3 })
  expect(surface.stats().purged).toBe(0)
})

test("rejects malformed placements without throwing or changing the plan", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ reportedProtocols: ["sixel"] }),
  })
  surface.place({ imageID: "a", generation: "g1", bytes: 100, rows: 2 })
  const before = surface.plan()

  const malformed = [
    { imageID: "", generation: "g1", bytes: 1, rows: 1 },
    { imageID: "x".repeat(257), generation: "g1", bytes: 1, rows: 1 },
    { imageID: "b", generation: "", bytes: 1, rows: 1 },
    { imageID: "b", generation: "g1", bytes: Number.NaN, rows: 1 },
    { imageID: "b", generation: "g1", bytes: 1, rows: -1 },
    { imageID: "b", generation: "g1", bytes: 1.5, rows: 1 },
  ]
  for (const request of malformed) {
    expect(() => surface.place(request)).not.toThrow()
    expect(surface.place(request)).toMatchObject({ status: "fallback", reason: "invalid_request" })
  }
  expect(surface.plan()).toEqual(before)
})

test("purges stale generations on resize or theme changes", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ reportedProtocols: ["kitty"] }),
  })
  surface.place({ imageID: "a", generation: "theme-dark", bytes: 100, rows: 2 })
  surface.place({ imageID: "b", generation: "theme-dark", bytes: 100, rows: 2 })

  expect(surface.purgeGeneration("theme-light")).toBe(2)
  expect(surface.plan()).toEqual({ images: 0, bytes: 0, rows: 0 })

  surface.place({ imageID: "a", generation: "theme-light", bytes: 100, rows: 2 })
  expect(surface.place({ imageID: "a", generation: "theme-light", bytes: 100, rows: 2 })).toMatchObject({ status: "placed" })
  expect(surface.stats().purged).toBeGreaterThan(0)
  expect(surface.release("a")).toBe(true)
  expect(surface.plan()).toEqual({ images: 0, bytes: 0, rows: 0 })
})

test("reports measured analytics provenance and never emits escape output", () => {
  const surface = createTerminalGraphicsSurface({
    negotiation: negotiateTerminalGraphics({ reportedProtocols: ["kitty"] }),
  })
  surface.place({ imageID: "a", generation: "g1", bytes: 256, rows: 3 })

  const observations = surface.observations()
  expect(observations.map(({ observedAtMs: _time, ...observation }) => observation)).toEqual([
    {
      metric: "ui.terminal_graphics.placed_images",
      value: 1,
      unit: "images",
      provenance: "measured",
      source: "terminal-graphics",
    },
    {
      metric: "ui.terminal_graphics.total_bytes",
      value: 256,
      unit: "bytes",
      provenance: "measured",
      source: "terminal-graphics",
    },
    {
      metric: "ui.terminal_graphics.reserved_rows",
      value: 3,
      unit: "rows",
      provenance: "measured",
      source: "terminal-graphics",
    },
    {
      metric: "ui.terminal_graphics.fallback_placements",
      value: 0,
      unit: "events",
      provenance: "measured",
      source: "terminal-graphics",
    },
  ])
  expect(observations.every((observation) => Number.isSafeInteger(observation.observedAtMs))).toBe(true)

  const decisions = [
    surface.place({ imageID: "bad", generation: "", bytes: 1, rows: 1 }),
    surface.place({ imageID: "a", generation: "g1", bytes: 10 * 1024 * 1024, rows: 1 }),
  ]
  expect(JSON.stringify(decisions)).not.toContain("\u001b")
})
