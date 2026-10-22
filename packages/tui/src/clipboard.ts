/** Clipboard adapter remains unavailable until a Guarded capability exists. */

export async function read() {
  // Reading requires a host clipboard bridge (often another process). Keep it
  // unavailable until that bridge has a Guarded, bounded protocol.
  return undefined
}

export function copyCommand(
  _os: NodeJS.Platform,
  _wayland: boolean,
  _has: (name: string) => boolean,
): string[] | undefined {
  // Retained for source compatibility; process-backed clipboard commands are
  // intentionally not resolved or launched in V1.
  return undefined
}

export async function write(text: string) {
  // OSC 52 is process-free but still mutates the host clipboard outside Guard.
  // Do not emit it until a Guarded clipboard capability/receipt exists.
  void text
}
