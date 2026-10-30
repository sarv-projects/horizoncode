/**
 * Supervised stdio entry point for the CodeMode interpreter.
 *
 * This process is launched only by HostKernel with a pinned executable and
 * helper asset. Stdout is reserved for the versioned CodeMode frame protocol;
 * diagnostics are bounded and sent to stderr. It has no direct tool, MCP,
 * provider, workspace, or network authority.
 */
import { CODE_MODE_FRAME_LIMITS_V1, encodeCodeModeFrameV1 } from "@/tool/code-mode-protocol"
import { runCodeModeHelperV1 } from "@/tool/code-mode-helper"

const MAX_FRAME_BYTES = CODE_MODE_FRAME_LIMITS_V1.maxFrameBytes

function frameReader() {
  const chunks = process.stdin[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)

  return async (): Promise<Uint8Array> => {
    for (;;) {
      const newline = pending.indexOf(0x0a)
      if (newline >= 0) {
        const frame = pending.subarray(0, newline + 1)
        pending = pending.subarray(newline + 1)
        if (frame.byteLength > MAX_FRAME_BYTES) throw new RangeError("CodeMode frame exceeds its byte bound")
        return new Uint8Array(frame)
      }
      if (pending.byteLength > MAX_FRAME_BYTES) throw new RangeError("CodeMode frame exceeds its byte bound")
      const next = await chunks.next()
      if (next.done) {
        if (pending.byteLength === 0) throw new Error("CodeMode host closed the protocol stream")
        throw new Error("CodeMode host closed with an incomplete frame")
      }
      pending = pending.byteLength === 0 ? Buffer.from(next.value) : Buffer.concat([pending, next.value])
    }
  }
}

async function main() {
  const readFrame = frameReader()
  const start = await readFrame()
  await runCodeModeHelperV1(start, {
    readFrame,
    writeFrame: async (frame) => {
      const bytes = encodeCodeModeFrameV1(frame)
      if (!process.stdout.write(bytes)) {
        await new Promise<void>((resolve, reject) => {
          process.stdout.once("drain", resolve)
          process.stdout.once("error", reject)
        })
      }
    },
  })
  process.stdin.pause()
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "CodeMode helper failed"
  process.stderr.write(`${message.slice(0, 512)}\n`)
  process.exitCode = 1
})
