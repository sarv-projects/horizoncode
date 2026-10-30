export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@horizoncode/schema/event"
import { EventManifest } from "@horizoncode/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
