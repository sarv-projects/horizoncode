import { expect, test } from "bun:test"
import * as sessionScroll from "../../src/util/session-scroll"

type Window = { startIndex: number; endIndex: number }
type TranscriptWindowApi = {
  transcriptWindowAt?: (messageCount: number, startIndex: number, maxMounted: number) => Window
  shiftTranscriptWindow?: (
    current: Window,
    messageCount: number,
    maxMounted: number,
    pageSize: number,
    direction: "older" | "newer",
  ) => Window
  reconcileTranscriptWindow?: (
    current: Window,
    previousCount: number,
    messageCount: number,
    maxMounted: number,
    followTail: boolean,
  ) => Window
}

const transcriptWindow = sessionScroll as typeof sessionScroll & TranscriptWindowApi

test("transcript windows mount a bounded ordered range and shift with overlap", () => {
  expect(transcriptWindow.transcriptWindowAt).toBeTypeOf("function")
  expect(transcriptWindow.shiftTranscriptWindow).toBeTypeOf("function")
  if (!transcriptWindow.transcriptWindowAt || !transcriptWindow.shiftTranscriptWindow) return

  const tail = transcriptWindow.transcriptWindowAt(10_000, 9_840, 160)
  expect(tail).toEqual({ startIndex: 9_840, endIndex: 10_000 })
  expect(tail.endIndex - tail.startIndex).toBeLessThanOrEqual(160)

  const older = transcriptWindow.shiftTranscriptWindow(tail, 10_000, 160, 80, "older")
  expect(older).toEqual({ startIndex: 9_760, endIndex: 9_920 })
  expect(older.endIndex).toBeGreaterThan(tail.startIndex)

  const newer = transcriptWindow.shiftTranscriptWindow(older, 10_000, 160, 80, "newer")
  expect(newer).toEqual(tail)
})

test("transcript append follows the tail only when the user was following it", () => {
  expect(transcriptWindow.reconcileTranscriptWindow).toBeTypeOf("function")
  if (!transcriptWindow.reconcileTranscriptWindow) return

  const tail = { startIndex: 12, endIndex: 20 }
  expect(transcriptWindow.reconcileTranscriptWindow(tail, 20, 22, 8, true)).toEqual({
    startIndex: 14,
    endIndex: 22,
  })
  expect(transcriptWindow.reconcileTranscriptWindow(tail, 20, 22, 8, false)).toEqual(tail)

  const older = { startIndex: 4, endIndex: 12 }
  expect(transcriptWindow.reconcileTranscriptWindow(older, 20, 22, 8, true)).toEqual(older)
})
