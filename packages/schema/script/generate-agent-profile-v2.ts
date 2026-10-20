import * as AgentProfile from "../src/agent-profile-v2"

const output = new URL("../../../arch_V1/contracts-v2/agent-profile-v2.schema.json", import.meta.url)
await Bun.write(output, `${JSON.stringify(AgentProfile.jsonSchemaDocument(), null, 2)}\n`)
