import { existsSync } from 'node:fs';

import { rgPath } from '@vscode/ripgrep';

/** Vendored ripgrep with a system-rg fallback (plan step 11 mitigation). */
export function rgBinary(): string {
  return existsSync(rgPath) ? rgPath : 'rg';
}
