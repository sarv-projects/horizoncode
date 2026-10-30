import { describe, expect, test } from "bun:test"
import { InstallationChannel, InstallationVersion } from "@horizoncode/core/installation/version"
import { USER_AGENT } from "../../../src/session/llm/user-agent"

describe("session.llm.request user agent", () => {
  test("uses the canonical OpenCode installation and CLI identity", () => {
    expect(USER_AGENT).toBe(`opencode/${InstallationChannel}/${InstallationVersion}/cli`)
  })
})
