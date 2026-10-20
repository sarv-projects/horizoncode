import {
  createSecretBroker,
  SecretBrokerError,
  type SecureInputHandleConsumer,
  type TrustedSecretUseContext,
} from "./secret-broker"
import { connectLinuxSecretServiceCredentialBackend } from "./secret-service"
import { createLinuxSecretServiceStore, type SecretServiceCredentialBackend } from "./secret-service-store"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"

export class CredentialStoreError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "UNAVAILABLE" | "CONFLICT" | "EXPIRED",
    message: string,
  ) {
    super(message)
    this.name = "CredentialStoreError"
  }
}

function safeError(error: unknown): CredentialStoreError {
  if (error instanceof CredentialStoreError) return error
  if (error instanceof SecretBrokerError) {
    if (error.code === "INVALID_REQUEST") return new CredentialStoreError("INVALID_REQUEST", "Credential request is invalid")
    if (error.code === "CONFLICT") return new CredentialStoreError("CONFLICT", "Credential changed; reload its status")
    if (error.code === "EXPIRED") return new CredentialStoreError("EXPIRED", "Credential input has expired or was already used")
  }
  return new CredentialStoreError("UNAVAILABLE", "Secure credential storage is unavailable")
}

export function createCredentialBrokerRuntime(options: {
  directory: string
  secureInput: SecureInputHandleConsumer
  openBackend?: () => Promise<SecretServiceCredentialBackend & { close?: () => Promise<void> }>
}) {
  type Opened = {
    broker: ReturnType<typeof createSecretBroker>
    store: Awaited<ReturnType<typeof createLinuxSecretServiceStore>>
  }
  let opened: Promise<Opened> | undefined
  let closed = false
  let activeOperations = 0
  let drainOperations: (() => void) | undefined
  let closing: Promise<void> | undefined

  const open = async () => {
    if (process.platform !== "linux") {
      throw new CredentialStoreError("UNAVAILABLE", "Secure credential storage is unavailable")
    }
    const backend = await (options.openBackend ?? connectLinuxSecretServiceCredentialBackend)()
    try {
      const store = await createLinuxSecretServiceStore({ directory: options.directory, backend })
      return { broker: createSecretBroker({ store, secureInput: options.secureInput }), store }
    } catch {
      await backend.close?.().catch(() => undefined)
      throw new CredentialStoreError("UNAVAILABLE", "Secure credential storage is unavailable")
    }
  }

  const get = async () => {
    if (closed) throw new CredentialStoreError("UNAVAILABLE", "Secure credential storage is unavailable")
    if (!opened) {
      opened = open().catch((error) => {
        opened = undefined
        throw safeError(error)
      })
    }
    return opened
  }

  const run = async <Value>(operation: (broker: Opened["broker"]) => Promise<Value>) => {
    const instance = await get()
    if (closed) throw new CredentialStoreError("UNAVAILABLE", "Secure credential storage is unavailable")
    activeOperations++
    try {
      return await operation(instance.broker)
    } finally {
      activeOperations--
      if (closed && activeOperations === 0) {
        drainOperations?.()
        drainOperations = undefined
      }
    }
  }

  return {
    async put(input: SecretBrokerV1.PutRequestV1) {
      try {
        return await run((broker) => broker.put(input))
      } catch (error) {
        throw safeError(error)
      }
    },
    async describe(secretRef: SecretBrokerV1.SecretRef) {
      try {
        return await run((broker) => broker.describe(secretRef))
      } catch (error) {
        throw safeError(error)
      }
    },
    async revoke(secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) {
      try {
        return await run((broker) => broker.revoke(secretRef, expectedVersion))
      } catch (error) {
        throw safeError(error)
      }
    },
    /** Issue a one-use lease only from an internal trusted Guard/ExecutionHost decision. */
    async authorizeUse(input: SecretBrokerV1.UseRequestV1, trusted: TrustedSecretUseContext) {
      try {
        return await run((broker) => broker.authorizeUse(input, trusted))
      } catch (error) {
        throw safeError(error)
      }
    },
    async close() {
      if (closing) return closing
      closed = true
      const current = opened
      opened = undefined
      closing = (async () => {
        const instance = current ? await current.catch(() => undefined) : undefined
        if (activeOperations > 0) await new Promise<void>((resolve) => (drainOperations = resolve))
        await instance?.store.close?.()
      })()
      return closing
    },
  }
}

export function createLazyProductionCredentialBroker(options: {
  directory: string
  secureInput: SecureInputHandleConsumer
}) {
  return createCredentialBrokerRuntime(options)
}
