/**
 * IPC command name mapping.
 */
export const ipcCommands = {
  seekTo: "seek_to",
  rangeFullData: "range_full_data",
  validateForkPatch: "validate_fork_patch",
  opDebug: "op_trace",
  scanConditions: "scan_conditions",
  resetSession: "reset_session",
} as const;
