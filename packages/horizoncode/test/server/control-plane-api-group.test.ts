import { expect, test } from "bun:test"
import { ControlPlaneApi } from "@/server/routes/instance/httpapi/groups/control-plane"

test("control-plane HTTP API group constructs its schemas at module load", () => {
  expect(ControlPlaneApi).toBeDefined()
})
