import { effectCmd, fail } from "../effect-cmd"

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run the agent",
  instance: false,
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: "PR number to checkout",
      demandOption: true,
    }),
  handler: () => fail("PR checkout is unavailable until guarded execution is implemented"),
})
