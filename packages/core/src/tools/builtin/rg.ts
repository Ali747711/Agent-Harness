import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Resolve ripgrep lazily (step 17). `@vscode/ripgrep` throws at IMPORT time
 * when its platform sub-package is missing, which is exactly what happens
 * inside a `bun build --compile` binary — a static import there breaks the
 * whole CLI at startup, not just search. So: try the vendored binary, fall
 * back to `rg` on PATH, and resolve at most once.
 */
let cached: string | null = null;

export function rgBinary(): string {
  if (cached !== null) {
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    const { rgPath } = require('@vscode/ripgrep') as { rgPath?: string };
    if (typeof rgPath === 'string' && existsSync(rgPath)) {
      cached = rgPath;
      return cached;
    }
  } catch {
    // Vendored copy unavailable (compiled binary, or a partial install).
  }
  cached = 'rg';
  return cached;
}

/** True when search will shell out to a system ripgrep rather than the vendored one. */
export function usingSystemRipgrep(): boolean {
  return rgBinary() === 'rg';
}

export const RIPGREP_MISSING_HINT =
  'ripgrep (rg) was not found. Install it (brew install ripgrep / apt install ripgrep) or run harness from a checkout where @vscode/ripgrep is installed.';
