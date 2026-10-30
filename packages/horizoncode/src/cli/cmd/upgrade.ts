import { CliError } from "../effect-cmd"

export const UpgradeCommand = {
  command: "upgrade",
  describe: "install HorizonCode updates (currently unavailable)",
  handler: async () => {
    throw new CliError({ message: "Installation upgrades are unavailable in this release." })
  },
}
