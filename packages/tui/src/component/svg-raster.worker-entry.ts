/**
 * Isolated SVG raster worker entry (Bun `Worker`). Receives bounded render
 * requests and runs the pure inert rasterizer; it has no filesystem, network or
 * host-capability access of its own.
 */
import { handleSvgRasterRequest, type SvgRasterBoundsV1 } from "./svg-raster"

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: unknown) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  const request = event?.data as { id?: unknown; source?: unknown; bounds?: unknown } | undefined
  if (!request || typeof request.id !== "string" || typeof request.source !== "string") return
  const result = handleSvgRasterRequest({
    source: request.source,
    bounds: request.bounds as Partial<SvgRasterBoundsV1> | undefined,
  })
  scope.postMessage({ id: request.id, result })
}
