/**
 * CommandRunner seam (ADR-0006 / PHASE1-PLAN step 10). Phase 1 ships
 * DirectCommandRunner; Phase 2 swaps in a sandboxed implementation
 * (@anthropic-ai/sandbox-runtime) behind this exact interface.
 */
export interface CommandRunOptions {
  /** Shell command string, executed via `bash -c` — never interpolated. */
  command: string;
  /** Working directory, pinned to the workspace root by the bash tool. */
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  /** Live combined stdout/stderr chunks (for tool_call_progress). */
  onChunk?: (chunk: string) => void;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandRunner {
  run(options: CommandRunOptions): Promise<CommandRunResult>;
}
