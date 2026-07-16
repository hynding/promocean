/** Shared result shape for both commands: never calls process.exit, so callers (and tests) drive it directly. */
export interface CommandResult {
  exitCode: number
  output: string
}
