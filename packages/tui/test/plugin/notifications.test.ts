import type { Event } from "@horizoncode/sdk/v2"
import type { TuiAttentionNotifyInput, TuiPluginApi, TuiPluginMeta } from "@horizoncode/plugin/tui"
import { expect, test } from "bun:test"
import Notifications from "../../src/feature-plugins/system/notifications"

const handlers = new Map<string, (event: unknown) => void>()
const notices: TuiAttentionNotifyInput[] = []

const api = {
  event: {
    on(type: string, handler: (event: never) => void) {
      handlers.set(type, (event) => handler(event as never))
      return () => handlers.delete(type)
    },
  },
  state: { session: { get: () => undefined } },
  attention: {
    notify: async (input: TuiAttentionNotifyInput) => {
      notices.push(input)
      return { ok: true, notification: true, sound: true }
    },
  },
} as unknown as TuiPluginApi

const metadata: TuiPluginMeta = {
  id: "internal:notifications",
  source: "internal",
  spec: "internal:notifications",
  target: "internal:notifications",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "first",
}

function emit(event: Event) {
  handlers.get(event.type)?.(event)
}

test("notifies once for V2 questions and clears notification state on reply or rejection", async () => {
  handlers.clear()
  notices.length = 0
  await Notifications.tui(api, undefined, metadata)

  const asked: Extract<Event, { type: "question.v2.asked" }> = {
    id: "evt-question-asked",
    type: "question.v2.asked",
    properties: { id: "que-v2-notification", sessionID: "ses-v2-notification", questions: [] },
  }
  emit(asked)
  emit({ ...asked, id: "evt-question-asked-duplicate" })
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    message: "Question needs input",
    sound: { name: "question", when: "always" },
  })

  emit({
    id: "evt-question-replied",
    type: "question.v2.replied",
    properties: { sessionID: asked.properties.sessionID, requestID: asked.properties.id, answers: [] },
  })
  emit({ ...asked, id: "evt-question-asked-after-reply" })
  expect(notices).toHaveLength(2)

  emit({
    id: "evt-question-rejected",
    type: "question.v2.rejected",
    properties: { sessionID: asked.properties.sessionID, requestID: asked.properties.id },
  })
  emit({ ...asked, id: "evt-question-asked-after-rejection" })
  expect(notices).toHaveLength(3)
})
