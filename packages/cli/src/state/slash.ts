/**
 * Slash commands (PHASE1-PLAN step 13's minimal set). Parsing and matching are
 * pure; execution lives in the controller so the UI never owns behaviour.
 */
export interface SlashCommand {
  name: string;
  summary: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', summary: 'show these commands and key bindings' },
  { name: 'clear', summary: 'start a fresh session (new transcript)' },
  { name: 'cost', summary: 'token and cost breakdown for this session' },
  { name: 'model', summary: 'show or switch the model — /model claude-sonnet-5' },
  { name: 'effort', summary: 'show or set reasoning effort — /effort medium' },
  { name: 'permissions', summary: 'show mode and rules — /permissions acceptEdits' },
  { name: 'config', summary: 'persist current settings — /config save' },
  { name: 'status', summary: 'model, workspace, memory, permission mode, usage' },
  { name: 'sessions', summary: 'list recent sessions for this project' },
  { name: 'exit', summary: 'quit harness' }
];

export interface ParsedCommand {
  name: string;
  args: string;
}

/** A line is a command only when it starts with '/' and names a word. */
export function parseSlash(line: string): ParsedCommand | null {
  const match = /^\/([a-z][a-z0-9-]*)\s*(.*)$/i.exec(line.trim());
  if (match === null) {
    return null;
  }
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Candidates for the autocomplete menu while typing '/…'. */
export function completions(line: string): SlashCommand[] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('/')) {
    return [];
  }
  // Once there is a space the command is settled; stop suggesting.
  if (trimmed.includes(' ')) {
    return [];
  }
  const prefix = trimmed.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export function isKnownCommand(name: string): boolean {
  return SLASH_COMMANDS.some((command) => command.name === name);
}
