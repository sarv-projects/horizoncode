import type { MetricProvenanceV1 } from "../context/ui-event-mux"

/**
 * Bounded terminal graphics negotiation and per-surface image budget (§31.9).
 *
 * Capabilities are established only from an explicit protocol report (for
 * example a positive Kitty graphics query response). A terminal name is
 * advisory metadata and can never establish a protocol, and any unknown or
 * absent evidence yields the text fallback. This module never emits escape
 * sequences or image payloads itself: it plans bounded placements, and every
 * unsupported path returns a source/text fallback decision instead.
 */

export type TerminalGraphicsProtocolV1 = "none" | "kitty" | "sixel"

export type TerminalGraphicsEvidenceV1 = {
  /** Explicit protocol reports; unknown values are ignored, never guessed. */
  reportedProtocols?: readonly string[]
  /** Advisory only; a terminal name alone never establishes a protocol. */
  terminalName?: string
  /** Operator/config opt-out wins over any positive evidence. */
  disabled?: boolean
}

export type TerminalGraphicsNegotiationV1 = {
  protocol: TerminalGraphicsProtocolV1
  /** Kitty can transmit once and place many; sixel re-transmits per placement. */
  transmitOnce: boolean
  reason: "disabled" | "no_explicit_protocol_evidence" | "explicit_protocol_report"
}

const KNOWN_PROTOCOLS: readonly TerminalGraphicsProtocolV1[] = ["kitty", "sixel"]

export function negotiateTerminalGraphics(
  evidence: TerminalGraphicsEvidenceV1 = {},
): TerminalGraphicsNegotiationV1 {
  if (evidence.disabled) return { protocol: "none", transmitOnce: false, reason: "disabled" }
  for (const protocol of KNOWN_PROTOCOLS) {
    if (evidence.reportedProtocols?.includes(protocol)) {
      return { protocol, transmitOnce: protocol === "kitty", reason: "explicit_protocol_report" }
    }
  }
  return { protocol: "none", transmitOnce: false, reason: "no_explicit_protocol_evidence" }
}

export type ImagePlacementRequestV1 = {
  imageID: string
  /** Source/resize/theme generation; a changed generation purges the old frame. */
  generation: string
  bytes: number
  rows: number
}

export type ImagePlacementDecisionV1 =
  | { status: "placed"; imageID: string; generation: string; bytes: number; rows: number }
  | {
      status: "fallback"
      imageID: string
      reason: "unsupported_protocol" | "invalid_request" | "image_budget" | "byte_budget" | "row_budget"
    }

export type ImagePlacementFallbackReasonV1 = Extract<ImagePlacementDecisionV1, { status: "fallback" }>["reason"]

export type TerminalGraphicsSurfaceOptionsV1 = {
  negotiation: TerminalGraphicsNegotiationV1
  /** Bounded placed-image entries. */
  maxImages?: number
  maxImageBytes?: number
  maxTotalBytes?: number
  maxReservedRows?: number
  /** Reserved rows can never exceed the known viewport height. */
  viewportRows?: number
}

export type TerminalGraphicsObservationV1 = {
  metric:
    | "ui.terminal_graphics.placed_images"
    | "ui.terminal_graphics.total_bytes"
    | "ui.terminal_graphics.reserved_rows"
    | "ui.terminal_graphics.fallback_placements"
  value: number
  unit: "images" | "bytes" | "rows" | "events"
  provenance: MetricProvenanceV1
  source: "terminal-graphics"
  observedAtMs: number
}

type PlacedImage = { imageID: string; generation: string; bytes: number; rows: number }

const DEFAULT_MAX_IMAGES = 4
const DEFAULT_MAX_IMAGE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_RESERVED_ROWS = 24
const DEFAULT_VIEWPORT_ROWS = 50
const MAX_IMAGE_ID_LENGTH = 256

function bounded(value: number | undefined, fallback: number, minimum: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

/**
 * Bounded per-surface graphics budget with explicit placement/fallback decisions,
 * generation purge (resize/theme), eviction and text fallback.
 */
export function createTerminalGraphicsSurface(options: TerminalGraphicsSurfaceOptionsV1) {
  const maxImages = bounded(options.maxImages, DEFAULT_MAX_IMAGES, 1)
  const maxImageBytes = bounded(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, 1)
  const maxTotalBytes = bounded(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1)
  const viewportRows = bounded(options.viewportRows, DEFAULT_VIEWPORT_ROWS, 1)
  const maxReservedRows = Math.min(bounded(options.maxReservedRows, DEFAULT_MAX_RESERVED_ROWS, 1), viewportRows)
  const protocol = options.negotiation.protocol
  const images = new Map<string, PlacedImage>()
  let placed = 0
  let fallbacks = 0
  let purged = 0

  function valid(request: unknown): request is ImagePlacementRequestV1 {
    if (typeof request !== "object" || request === null) return false
    const candidate = request as Partial<ImagePlacementRequestV1>
    return (
      typeof candidate.imageID === "string" &&
      candidate.imageID.length > 0 &&
      candidate.imageID.length <= MAX_IMAGE_ID_LENGTH &&
      typeof candidate.generation === "string" &&
      candidate.generation.length > 0 &&
      candidate.generation.length <= MAX_IMAGE_ID_LENGTH &&
      Number.isSafeInteger(candidate.bytes) &&
      (candidate.bytes ?? 0) > 0 &&
      Number.isSafeInteger(candidate.rows) &&
      (candidate.rows ?? 0) > 0
    )
  }

  function fallback(imageID: string, reason: ImagePlacementFallbackReasonV1): ImagePlacementDecisionV1 {
    fallbacks++
    return { status: "fallback", imageID, reason }
  }

  function totalBytes() {
    let total = 0
    for (const image of images.values()) total += image.bytes
    return total
  }

  function totalRows() {
    let total = 0
    for (const image of images.values()) total += image.rows
    return total
  }

  function place(request: ImagePlacementRequestV1): ImagePlacementDecisionV1 {
    if (!valid(request)) return fallback(typeof request === "object" && request !== null ? String((request as { imageID?: unknown }).imageID ?? "") : "", "invalid_request")
    if (protocol === "none") return fallback(request.imageID, "unsupported_protocol")

    // Per-image bounds are checked before any eviction.
    if (request.bytes > maxImageBytes || request.rows > maxReservedRows) {
      return fallback(request.imageID, request.bytes > maxImageBytes ? "byte_budget" : "row_budget")
    }

    const previous = images.get(request.imageID)
    const evictions: PlacedImage[] = []
    let projectedImageCount = images.size + (previous ? 0 : 1)
    for (const image of images.values()) {
      if (projectedImageCount <= maxImages) break
      if (image.imageID === request.imageID) continue
      evictions.push(image)
      projectedImageCount--
    }

    const evictedBytes = evictions.reduce((sum, image) => sum + image.bytes, 0)
    const evictedRows = evictions.reduce((sum, image) => sum + image.rows, 0)
    const projectedBytes = totalBytes() - (previous?.bytes ?? 0) - evictedBytes + request.bytes
    const projectedRows = totalRows() - (previous?.rows ?? 0) - evictedRows + request.rows
    if (projectedBytes > maxTotalBytes) return fallback(request.imageID, "byte_budget")
    if (projectedRows > maxReservedRows) return fallback(request.imageID, "row_budget")

    for (const image of evictions) {
      images.delete(image.imageID)
      purged++
    }
    if (previous) images.delete(request.imageID)
    if (previous && previous.generation !== request.generation) purged++

    images.set(request.imageID, {
      imageID: request.imageID,
      generation: request.generation,
      bytes: request.bytes,
      rows: request.rows,
    })
    placed++
    return { status: "placed", imageID: request.imageID, generation: request.generation, bytes: request.bytes, rows: request.rows }
  }

  return {
    protocol() {
      return protocol
    },
    transmitOnce() {
      return options.negotiation.transmitOnce
    },
    place,
    release(imageID: string) {
      return images.delete(imageID)
    },
    /** Purge every placement whose generation is stale (resize/theme change). */
    purgeGeneration(currentGeneration: string) {
      let removed = 0
      for (const [imageID, image] of images) {
        if (image.generation === currentGeneration) continue
        images.delete(imageID)
        removed++
      }
      purged += removed
      return removed
    },
    plan() {
      return { images: images.size, bytes: totalBytes(), rows: totalRows() }
    },
    observations(): TerminalGraphicsObservationV1[] {
      const observedAtMs = Date.now()
      const plan = this.plan()
      const stats = this.stats()
      return [
        {
          metric: "ui.terminal_graphics.placed_images",
          value: plan.images,
          unit: "images",
          provenance: "measured",
          source: "terminal-graphics",
          observedAtMs,
        },
        {
          metric: "ui.terminal_graphics.total_bytes",
          value: plan.bytes,
          unit: "bytes",
          provenance: "measured",
          source: "terminal-graphics",
          observedAtMs,
        },
        {
          metric: "ui.terminal_graphics.reserved_rows",
          value: plan.rows,
          unit: "rows",
          provenance: "measured",
          source: "terminal-graphics",
          observedAtMs,
        },
        {
          metric: "ui.terminal_graphics.fallback_placements",
          value: stats.fallbacks,
          unit: "events",
          provenance: "measured",
          source: "terminal-graphics",
          observedAtMs,
        },
      ]
    },
    stats() {
      return { placed, fallbacks, purged, pending: images.size }
    },
  }
}
