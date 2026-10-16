import { expect, mock, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
let sync: {
  data: { config: Record<string, unknown>; path: { directory: string } }
  updateConfig: (patch: Record<string, unknown>) => Promise<void>
  featureExposure: {
    get: (directory: string) => Promise<FeatureExposure.Feature[]>
    update: (directory: string, input: FeatureExposure.Update) => Promise<FeatureExposure.Feature[]>
  }
}
const notices: { variant?: string; title?: string; description?: string }[] = []

mock.module("@/context/server-sync", () => ({ useServerSync: () => () => sync }))
mock.module("@/utils/toast", () => ({ showToast: (notice: (typeof notices)[number]) => notices.push(notice) }))

// Load after installing test doubles so the component binds the mocked config and toast owners.
const { SettingsFeaturesV2 } = await import("../src/components/settings-v2/features")

function mount(experimentalOnly = true) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(SettingsFeaturesV2, { experimentalOnly }), host)
  return { host, dispose }
}

test("desktop unavailable experiments are disabled and never call feature update", async () => {
  let updates = 0
  sync = {
    data: { config: {}, path: { directory: "/workspace" } },
    updateConfig: async () => {},
    featureExposure: {
      get: async () => FeatureExposure.list({}),
      update: async () => {
        updates++
        return FeatureExposure.list({})
      },
    },
  }

  const view = mount()
  await Bun.sleep(0)
  try {
    const unavailable = view.host.querySelector<HTMLInputElement>("input[data-slot='switch-input']")
    expect(view.host.textContent).toContain("Not implemented or release-verified")
    expect(view.host.textContent).toContain("Requested: default off")
    expect(view.host.textContent).toContain("Effective: off (unavailable)")
    expect(view.host.textContent).toContain("Source: default")
    expect(view.host.textContent).toContain("Policy lock: unknown")
    expect(view.host.textContent).toContain("Scope: project")
    expect(view.host.textContent).toContain("Applies next turn")
    expect(unavailable).toBeTruthy()
    expect(unavailable!.disabled).toBe(true)
    unavailable!.click()
    expect(updates).toBe(0)
  } finally {
    view.dispose()
    view.host.remove()
  }
})

test("desktop save failure reports failure without success or local config mutation", async () => {
  const config = { compaction: { auto: false } }
  let updates = 0
  notices.length = 0
  sync = {
    data: { config, path: { directory: "/workspace" } },
    updateConfig: async () => {},
    featureExposure: {
      get: async () => FeatureExposure.list(config),
      update: async () => {
        updates++
        throw new Error("conflict")
      },
    },
  }
  const view = mount(false)
  await Bun.sleep(0)
  try {
    const automatic = view.host.querySelector<HTMLInputElement>("input[data-slot='switch-input']")
    expect(automatic).toBeTruthy()
    automatic!.click()
    await Bun.sleep(0)

    expect(updates).toBe(1)
    expect(config.compaction.auto).toBe(false)
    expect(notices).toEqual([
      { variant: "error", title: "Could not save setting", description: "conflict" },
    ])
  } finally {
    view.dispose()
    view.host.remove()
  }
})
