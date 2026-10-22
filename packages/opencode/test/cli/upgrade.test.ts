import { expect, it, spyOn } from "bun:test"
import { Installation } from "../../src/installation"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"
import { upgrade as automaticUpgrade } from "../../src/cli/upgrade"

it("keeps upgrade unavailable without querying or invoking the installer", async () => {
  const method = spyOn(Installation, "method").mockResolvedValue("npm")
  const installerUpgrade = spyOn(Installation, "upgrade").mockResolvedValue(undefined)
  try {
    await expect(UpgradeCommand.handler()).rejects.toMatchObject({
      message: "Installation upgrades are unavailable in this release.",
    })
    await automaticUpgrade()

    expect(method).not.toHaveBeenCalled()
    expect(installerUpgrade).not.toHaveBeenCalled()
  } finally {
    method.mockRestore()
    installerUpgrade.mockRestore()
  }
})
