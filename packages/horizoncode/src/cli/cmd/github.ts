import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"

const unavailable = "GitHub automation is unavailable until guarded execution is implemented"

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  instance: false,
  handler: () => fail(unavailable),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      }),
  handler: () => fail(unavailable),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "manage the GitHub agent",
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
