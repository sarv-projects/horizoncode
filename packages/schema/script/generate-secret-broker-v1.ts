import { SecretBrokerV1 } from "../src/secret-broker-v1"

const output = new URL("../src/secret-broker-v1.schema.json", import.meta.url)
await Bun.write(output, `${JSON.stringify(SecretBrokerV1.jsonSchemaDocument(), null, 2)}\n`)
