/**
 * HorizonCode deliberately disables the inherited Git-backed snapshot CLI.
 *
 * Checkpoint/rewind is a separate Rust-owned capability and remains unavailable
 * until its Guarded restore path is integrated. Keep this hydrated source path
 * as a fail-closed marker so the upstream Snapshot service cannot be pulled into
 * the runnable CLI by an accidental import.
 */
export const HorizonCodeLegacySnapshotDebugCommand = {
  command: "snapshot",
  enabled: false,
} as const
