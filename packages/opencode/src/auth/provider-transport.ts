import { createHash } from "node:crypto"
import { SecretBrokerError, type TrustedSecretUseContext } from "./secret-broker"
import type { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"

const MAX_PROVIDER_BODY_BYTES = 1024 * 1024

export type ProviderTransportInput = {
  providerId: string
  method: "POST"
  destination: string
  body: string
  headers: Record<string, string>
  credentialHeader: { name: "authorization" | "x-api-key"; prefix: string }
}

export type ProviderTransportRequest = {
  url: string
  method: "POST"
  body: string
  headers: Record<string, string>
  signal: AbortSignal
  maxResponseBytes: number
}

const canonicalHeaders = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n")

export function providerRequestDigest(
  input: Pick<ProviderTransportInput, "providerId" | "method" | "destination" | "body" | "headers" | "credentialHeader">,
) {
  return `sha256:${createHash("sha256")
    .update(
      `provider-request-v1\n${input.providerId}\n${input.method}\n${input.destination}\n${input.credentialHeader.name}\n${input.credentialHeader.prefix}\n${canonicalHeaders(input.headers)}\n${input.body}`,
      "utf8",
    )
    .digest("hex")}` as SecretBrokerV1.SecretOperationDigest
}

/**
 * Consume one broker lease immediately around one first-party provider send.
 * This adapter is deliberately not wired into production dispatch until the
 * Guard authorization path is verified. It never returns credential bytes or
 * auth headers to its caller.
 */
export async function dispatchProviderRequest<Value>(options: {
  broker: Pick<ReturnType<typeof import("./secret-broker").createSecretBroker>, "withUse">
  lease: SecretBrokerV1.UseLeaseV1
  trusted: TrustedSecretUseContext
  input: ProviderTransportInput
  send: (request: ProviderTransportRequest) => Promise<AsyncIterable<Uint8Array>>
  signal?: AbortSignal
  deadlineAt: number
  maxResponseBytes: number
  now?: () => number
}): Promise<AsyncIterable<Uint8Array>> {
  const { input, lease, trusted } = options
  const now = options.now ?? Date.now
  const responseLimit = options.maxResponseBytes
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= now()) {
    throw new SecretBrokerError("EXPIRED", "Provider request deadline has expired")
  }
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 10 * 1024 * 1024) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider response bound is invalid")
  }
  if (options.signal?.aborted) throw new SecretBrokerError("EXPIRED", "Provider request was cancelled")
  if (
    input.providerId !== trusted.providerId ||
    input.providerId !== lease.providerId ||
    input.destination !== trusted.destination ||
    input.destination !== lease.destination ||
    providerRequestDigest(input) !== trusted.operationDigest ||
    providerRequestDigest(input) !== lease.operationDigest
  ) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request does not match its authorized lease")
  }
  let url: URL
  try {
    url = new URL(input.destination)
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider destination is invalid")
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.toString() !== input.destination ||
    new TextEncoder().encode(input.body).byteLength > MAX_PROVIDER_BODY_BYTES
  ) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request is outside the supported transport bounds")
  }
  const headerEntries = Object.entries(input.headers)
  if (headerEntries.length > 64) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header count limit")
  }
  const headers: Record<string, string> = {}
  let headerBytes = 0
  for (const [rawName, value] of headerEntries) {
    const name = rawName.toLowerCase()
    if (
      name.length > 128 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/.test(name) ||
      /[\r\n\u0000]/.test(value)
    ) {
      throw new SecretBrokerError("INVALID_REQUEST", "Provider request headers contain a forbidden credential field")
    }
    headerBytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(value).byteLength
    if (headerBytes > 32 * 1024) {
      throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header size limit")
    }
    headers[name] = value
  }
  const credentialHeader = input.credentialHeader.name
  if (Object.hasOwn(headers, credentialHeader)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request already contains an auth header")
  }
  if (input.credentialHeader.prefix.length > 32 || /[\r\n\u0000]/.test(input.credentialHeader.prefix)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider authentication format is invalid")
  }
  if (headerBytes + new TextEncoder().encode(input.credentialHeader.prefix).byteLength + 16 * 1024 > 32 * 1024) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header size limit")
  }

  return options.broker.withUse(lease, trusted, async (bytes) => {
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abortFromCaller, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abortFromCaller)
    }
    controller.signal.addEventListener("abort", cleanup, { once: true })
    const abortError = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new SecretBrokerError("EXPIRED", "Provider request was cancelled or exceeded its deadline")),
        { once: true },
      )
    })
    let credential: string
    const remaining = options.deadlineAt - now()
    if (remaining <= 0 || controller.signal.aborted) {
      cleanup()
      throw new SecretBrokerError("EXPIRED", "Provider request was cancelled or exceeded its deadline")
    }
    try {
      timeout = setTimeout(() => controller.abort(), remaining)
      credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      controller.abort()
      throw new SecretBrokerError("UNAVAILABLE", "Stored provider credential is invalid")
    }
    if (credential.length === 0 || /[\r\n\u0000]/.test(credential)) {
      controller.abort()
      throw new SecretBrokerError("UNAVAILABLE", "Stored provider credential is invalid")
    }
    headers[credentialHeader] = `${input.credentialHeader.prefix}${credential}`
    try {
      let response: AsyncIterable<Uint8Array>
      try {
        response = await Promise.race([
          options.send({
            url: input.destination,
            method: input.method,
            body: input.body,
            headers,
            signal: controller.signal,
            maxResponseBytes: responseLimit,
          }),
          abortError,
        ])
      } catch (error) {
        controller.abort()
        cleanup()
        throw error
      }
      return (async function* () {
        let consumed = 0
        const iterator = response[Symbol.asyncIterator]()
        try {
          while (true) {
            const next = await Promise.race([Promise.resolve(iterator.next()), abortError])
            if (next.done) break
            const chunk = next.value
            if (controller.signal.aborted) {
              throw new SecretBrokerError("EXPIRED", "Provider response was cancelled or exceeded its deadline")
            }
            if (!(chunk instanceof Uint8Array) || consumed + chunk.byteLength > responseLimit) {
              controller.abort()
              throw new SecretBrokerError("UNAVAILABLE", "Provider response exceeded its size limit")
            }
            consumed += chunk.byteLength
            yield chunk
          }
        } finally {
          cleanup()
          if (!controller.signal.aborted) controller.abort()
          void Promise.resolve(iterator.return?.()).catch(() => undefined)
        }
      })()
    } finally {
      delete headers[credentialHeader]
      credential = ""
    }
  })
}
