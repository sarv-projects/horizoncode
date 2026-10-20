import { createMemo } from "solid-js"
import { useSync } from "../context/sync"
import { hasConnectedProvider } from "../util/model"

export function useConnected() {
  const sync = useSync()
  return createMemo(() => hasConnectedProvider(sync.data.provider_next.connected))
}
