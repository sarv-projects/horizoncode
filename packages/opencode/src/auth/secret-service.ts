import { createCipheriv, createDecipheriv, hkdfSync, randomBytes as nodeRandomBytes } from "node:crypto"
import * as dbus from "dbus-native"
import type { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import type { SecretServiceCredentialBackend } from "./secret-service-store"

/**
 * RFC 2409 group 2 (1024-bit MODP) prime. The negotiated algorithm is
 * `dh-ietf1024-sha256-aes128-cbc-pkcs7`, so both sides exchange 128-byte values;
 * the 768-bit group-1 prime is too small and rejects every real Secret Service
 * public key as out of range.
 */
const GROUP_2_PRIME = BigInt(
  "0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff",
)
const GENERATOR = 2n
export const SECRET_SERVICE_ALGORITHM = "dh-ietf1024-sha256-aes128-cbc-pkcs7"

function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.byteLength === 0) return 0n
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`)
}

function bigIntToBytes(value: bigint): Buffer {
  if (value <= 0n) throw new Error("invalid Diffie-Hellman integer")
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, "hex")
}

/** RFC 2409 group-2 DH values are exchanged as fixed 128-byte big-endian buffers. */
const DH_GROUP_BYTES = 128

function bigIntToFixedBytes(value: bigint): Buffer {
  const bytes = bigIntToBytes(value)
  if (bytes.byteLength > DH_GROUP_BYTES) throw new Error("Diffie-Hellman integer exceeds the group size")
  if (bytes.byteLength === DH_GROUP_BYTES) return bytes
  return Buffer.concat([Buffer.alloc(DH_GROUP_BYTES - bytes.byteLength), bytes])
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let value = 1n
  let factor = base % modulus
  let remaining = exponent
  while (remaining > 0n) {
    if (remaining & 1n) value = (value * factor) % modulus
    factor = (factor * factor) % modulus
    remaining >>= 1n
  }
  return value
}

/** Creates the RFC 2409 group-2 half of a Secret Service encrypted session. */
export function beginSecretServiceDhSession(options: {
  random?: (size: number) => Uint8Array
  privateExponent?: bigint
} = {}) {
  const random = options.random ?? nodeRandomBytes
  const exponent = options.privateExponent ?? (bytesToBigInt(random(128)) % (GROUP_2_PRIME - 3n)) + 2n
  const clientPublic = bigIntToFixedBytes(modPow(GENERATOR, exponent, GROUP_2_PRIME))
  let key: Buffer | undefined

  return {
    clientPublicKey: clientPublic,
    complete(servicePublicKey: Uint8Array) {
      const remote = bytesToBigInt(servicePublicKey)
      if (remote <= 1n || remote >= GROUP_2_PRIME - 1n || servicePublicKey.byteLength > DH_GROUP_BYTES) {
        throw new Error("invalid Secret Service DH public key")
      }
      // The negotiated key is derived from the fixed-width shared secret, exactly
      // as libsecret does; a stripped leading zero would change the key.
      const shared = bigIntToFixedBytes(modPow(remote, exponent, GROUP_2_PRIME))
      try {
        key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.alloc(0), 16))
      } finally {
        shared.fill(0)
      }
    },
    encrypt(value: Uint8Array): { parameters: Buffer; value: Buffer } {
      if (!key) throw new Error("Secret Service DH session is not complete")
      const parameters = random(16)
      if (parameters.byteLength !== 16) throw new Error("invalid Secret Service IV")
      const cipher = createCipheriv("aes-128-cbc", key, parameters)
      return { parameters: Buffer.from(parameters), value: Buffer.concat([cipher.update(value), cipher.final()]) }
    },
    decrypt(parameters: Uint8Array, value: Uint8Array): Buffer {
      if (!key) throw new Error("Secret Service DH session is not complete")
      if (parameters.byteLength !== 16 || value.byteLength === 0 || value.byteLength % 16 !== 0) {
        throw new Error("invalid Secret Service encrypted payload")
      }
      const decipher = createDecipheriv("aes-128-cbc", key, parameters)
      return Buffer.concat([decipher.update(value), decipher.final()])
    },
    close() {
      key?.fill(0)
      key = undefined
      clientPublic.fill(0)
    },
  }
}

/**
 * Narrow D-Bus session surface. The actual connection always disables Unix-FD
 * transport; Secret Service secrets use its negotiated encrypted byte-array
 * protocol, never plaintext or FD fallback.
 */
export interface SecretServiceSessionApi {
  OpenSession(algorithm: string, input: unknown): Promise<unknown>
}

interface SecretServiceCloseApi {
  Close(): Promise<void>
}

interface SecretServiceRootApi extends SecretServiceSessionApi {
  ReadAlias(name: string): Promise<unknown>
  SearchItems(attributes: Record<string, string>): Promise<unknown>
}

interface SecretServiceCollectionApi {
  CreateItem(properties: unknown, secret: unknown, replace: boolean): Promise<unknown>
}

interface SecretServiceItemApi {
  GetSecret(session: string): Promise<unknown>
  Delete(): Promise<unknown>
}

interface SecretServicePromptApi {
  Dismiss(): Promise<void>
}

interface SecretServiceInterfaceFactory {
  getInterface<Value>(path: string, interfaceName: string): Promise<Value>
}

export async function negotiateSecretServiceSession(
  service: SecretServiceSessionApi,
  variant: (signature: string, value: unknown) => unknown,
  valueOfVariant: (value: unknown) => unknown,
  random?: (size: number) => Uint8Array,
) {
  const exchange = beginSecretServiceDhSession({ random })
  try {
    const response = await service.OpenSession(SECRET_SERVICE_ALGORITHM, variant("ay", exchange.clientPublicKey))
    if (!Array.isArray(response) || response.length !== 2) throw new Error("invalid Secret Service OpenSession reply")
    const [servicePublic, sessionPath] = response
    const publicBytes = valueOfVariant(servicePublic)
    if (!(publicBytes instanceof Uint8Array) || typeof sessionPath !== "string" || !sessionPath.startsWith("/")) {
      throw new Error("invalid Secret Service OpenSession result")
    }
    exchange.complete(publicBytes)
    return { sessionPath, cipher: exchange }
  } catch (error) {
    exchange.close()
    throw error
  }
}

/** Opens an encrypted Secret Service session on the current Linux login bus. */
export async function connectLinuxSecretServiceSession() {
  if (process.platform !== "linux") throw new Error("Linux Secret Service is unavailable on this platform")
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error("Linux Secret Service session bus is unavailable")

  // Never negotiate UNIX_FD or the Secret Service `plain` algorithm. The
  // protocol's encrypted Secret struct is used for every credential payload.
  const bus = dbus.sessionBus({ fdTransport: false, timeout: 5_000, plainValues: true, variants: "wrap", ayBuffer: true })
  let session: Awaited<ReturnType<typeof negotiateSecretServiceSession>> | undefined
  try {
    const service = await bus.getService("org.freedesktop.secrets")
    const api = await service.getInterface<SecretServiceSessionApi>(
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service",
    )
    session = await negotiateSecretServiceSession(
      api,
      (signature, value) => new dbus.Variant(signature, value),
      (value) => dbus.variantValue(value),
    )
    const control = await service.getInterface<SecretServiceCloseApi>(session.sessionPath, "org.freedesktop.Secret.Session")
    return {
      sessionPath: session.sessionPath,
      cipher: session.cipher,
      service: service as unknown as SecretServiceInterfaceFactory,
      variant: (signature: string, value: unknown) => new dbus.Variant(signature, value),
      valueOfVariant: (value: unknown) => dbus.variantValue(value),
      async close() {
        try {
          await control.Close()
        } finally {
          session?.cipher.close()
          await bus.connection[Symbol.asyncDispose]()
        }
      },
    }
  } catch {
    session?.cipher.close()
    await bus.connection[Symbol.asyncDispose]().catch(() => undefined)
    throw new Error("Linux Secret Service encrypted session could not be established")
  }
}

function tuple(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error("Secret Service returned a malformed result")
  return value
}

function objectPath(value: unknown): string {
  if (typeof value !== "string" || !dbus.isValidObjectPath(value)) {
    throw new Error("Secret Service returned an invalid object path")
  }
  return value
}

/**
 * Connects the durable store to the login keyring. Every secret payload uses
 * the negotiated encrypted Secret struct; plain mode, file descriptors and
 * prompting are not accepted. If the default collection is locked or absent,
 * this adapter fails closed and leaves existing credentials untouched.
 */
export async function connectLinuxSecretServiceCredentialBackend(): Promise<SecretServiceCredentialBackend & { close(): Promise<void> }> {
  return createSecretServiceCredentialBackend(await connectLinuxSecretServiceSession())
}

/** Internal adapter seam for encrypted-session protocol contract tests. */
export async function createSecretServiceCredentialBackend(session: Awaited<ReturnType<typeof connectLinuxSecretServiceSession>>): Promise<SecretServiceCredentialBackend & { close(): Promise<void> }> {
  try {
    const root = await session.service.getInterface<SecretServiceRootApi>(
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service",
    )
    const collectionPath = objectPath(session.valueOfVariant(await root.ReadAlias("default")))
    if (collectionPath === "/") throw new Error("default Secret Service collection is unavailable")
    const collection = await session.service.getInterface<SecretServiceCollectionApi>(
      collectionPath,
      "org.freedesktop.Secret.Collection",
    )

    const dismissUnexpectedPrompt = async (promptValue: unknown) => {
      const promptPath = objectPath(promptValue)
      if (promptPath === "/") return
      const prompt = await session.service.getInterface<SecretServicePromptApi>(
        promptPath,
        "org.freedesktop.Secret.Prompt",
      )
      await prompt.Dismiss().catch(() => undefined)
      throw new Error("Secret Service requires an interactive prompt")
    }

    const findItems = async (secretRef: SecretBrokerV1.SecretRef, version: number) => {
      const [unlocked, locked] = tuple(await root.SearchItems({
        "horizoncode.product": "horizoncode",
        "horizoncode.secret_ref": secretRef,
        "horizoncode.secret_version": String(version),
      }), 2)
      if (!Array.isArray(unlocked) || !Array.isArray(locked) || unlocked.length > 32 || locked.length > 32) {
        throw new Error("Secret Service returned malformed or excessive item search results")
      }
      if (locked.length > 0) throw new Error("Secret Service item is locked")
      return unlocked.map(objectPath).filter((path) => path !== "/")
    }
    const findUniqueItem = async (secretRef: SecretBrokerV1.SecretRef, version: number, allowMissing = false) => {
      const paths = await findItems(secretRef, version)
      if (paths.length === 0 && allowMissing) return undefined
      if (paths.length !== 1) throw new Error("Secret Service credential is absent or ambiguous")
      return paths[0]!
    }
    const deleteItem = async (itemPath: string) => {
      const item = await session.service.getInterface<SecretServiceItemApi>(itemPath, "org.freedesktop.Secret.Item")
      await dismissUnexpectedPrompt(await item.Delete())
    }

    return {
      async createSecret(secretRef: SecretBrokerV1.SecretRef, version: number, bytes: Uint8Array) {
        const encrypted = session.cipher.encrypt(bytes)
        try {
          const properties = {
            "org.freedesktop.Secret.Item.Label": session.variant("s", "HorizonCode provider credential"),
            "org.freedesktop.Secret.Item.Attributes": session.variant("a{ss}", {
              "horizoncode.secret_ref": secretRef,
              "horizoncode.secret_version": String(version),
              "horizoncode.product": "horizoncode",
            }),
          }
          const secret = [session.sessionPath, encrypted.parameters, encrypted.value, "text/plain; charset=utf-8"]
          const [itemValue, promptValue] = tuple(await collection.CreateItem(properties, secret, false), 2)
          await dismissUnexpectedPrompt(promptValue)
          const itemPath = objectPath(itemValue)
          if (itemPath === "/") throw new Error("Secret Service did not create an item")
          if (await findUniqueItem(secretRef, version) !== itemPath) {
            throw new Error("Secret Service did not retain the credential lookup attributes")
          }
          return itemPath
        } finally {
          encrypted.parameters.fill(0)
          encrypted.value.fill(0)
        }
      },
      async getSecret(_itemValue: string, secretRef: SecretBrokerV1.SecretRef, version: number) {
        const itemPath = (await findUniqueItem(secretRef, version))!
        const item = await session.service.getInterface<SecretServiceItemApi>(itemPath, "org.freedesktop.Secret.Item")
        // dbus-native resolves a single OUT argument directly; Secret is the
        // four-field struct, not a singleton wrapper containing that struct.
        const [secretSession, parameters, ciphertext, contentType] = tuple(await item.GetSecret(session.sessionPath), 4)
        if (secretSession !== session.sessionPath || !(parameters instanceof Uint8Array) || !(ciphertext instanceof Uint8Array) ||
            ciphertext.byteLength > 16 * 1024 + 16 || typeof contentType !== "string") {
          throw new Error("Secret Service returned a malformed encrypted secret")
        }
        const clear = session.cipher.decrypt(parameters, ciphertext)
        try {
          if (clear.byteLength === 0 || clear.byteLength > 16 * 1024) throw new Error("Secret Service returned an invalid secret size")
          return Uint8Array.from(clear)
        } finally {
          clear.fill(0)
        }
      },
      async deleteSecret(_itemValue: string, secretRef: SecretBrokerV1.SecretRef, version: number) {
        const itemPath = await findUniqueItem(secretRef, version, true)
        if (itemPath) await deleteItem(itemPath)
      },
      async deleteOrphanedSecret(secretRef: SecretBrokerV1.SecretRef, version: number) {
        for (const itemPath of await findItems(secretRef, version)) await deleteItem(itemPath)
      },
      close: session.close,
    }
  } catch (error) {
    await session.close().catch(() => undefined)
    throw error
  }
}
