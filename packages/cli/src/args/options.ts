/**
 * Raw commander output → config flag layer. Pure and unit-tested; validation
 * (including unknown-key rejection) happens in core's loadConfig, which
 * attributes errors to the 'flags' origin.
 */
export interface RawCliOptions {
  print?: string;
  outputFormat?: string;
  model?: string;
  effort?: string;
  thinking?: string;
  maxTokens?: string;
  maxTurns?: string;
  permissionMode?: string;
  cwd?: string;
}

export function flagsFromCli(raw: RawCliOptions): Record<string, unknown> {
  return {
    ...(raw.model !== undefined && { model: raw.model }),
    ...(raw.effort !== undefined && { effort: raw.effort }),
    ...(raw.thinking !== undefined && { thinking: raw.thinking }),
    ...(raw.maxTokens !== undefined && { maxTokens: Number(raw.maxTokens) }),
    ...(raw.maxTurns !== undefined && { maxTurns: Number(raw.maxTurns) }),
    ...(raw.permissionMode !== undefined && { permissionMode: raw.permissionMode })
  };
}
