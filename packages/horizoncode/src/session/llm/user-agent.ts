import { InstallationChannel, InstallationVersion } from "@horizoncode/core/installation/version"

// Keep provider requests on the same client identity used by OpenCode's
// installation/runtime requests. In source builds the channel and version are
// truthfully reported as "local" instead of substituting a release identity.
export const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/cli`
