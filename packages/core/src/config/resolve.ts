import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HarnessError } from '../errors/index.ts';
import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  type Config,
  ConfigSchema,
  isNestedConfigKey,
  type PartialConfig,
  PartialConfigSchema
} from './schema.ts';

/**
 * Scope resolution (PHASE1-PLAN.md step 2):
 *   defaults → user (~/.harness/config.json) → project (<cwd>/.harness/config.json)
 *   → env (HARNESS_*) → flags.
 * Each layer is strict-parsed individually so violations carry their origin.
 * Per-key sources are tracked for `config show`.
 */
export type ConfigLayer = 'default' | 'user' | 'project' | 'env' | 'flag';

export interface ResolvedConfig {
  config: Config;
  sources: Record<keyof Config, ConfigLayer>;
}

export interface LoadConfigOptions {
  /** Workspace root; the project config lives at <cwd>/.harness/config.json. */
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Untrusted (e.g. commander output) — strict-validated, unknown keys rejected. */
  flags?: unknown;
  userConfigPath?: string;
  projectConfigPath?: string;
  /** Injected for tests. Returns null when the file does not exist. */
  readTextFile?: (path: string) => Promise<string | null>;
}

const ENV_KEY_MAP: ReadonlyArray<{
  envVar: string;
  key: keyof Config;
  kind: 'string' | 'number' | 'list';
}> = [
  { envVar: 'HARNESS_MODEL', key: 'model', kind: 'string' },
  { envVar: 'HARNESS_EFFORT', key: 'effort', kind: 'string' },
  { envVar: 'HARNESS_THINKING', key: 'thinking', kind: 'string' },
  { envVar: 'HARNESS_MAX_TOKENS', key: 'maxTokens', kind: 'number' },
  { envVar: 'HARNESS_MAX_TURNS', key: 'maxTurns', kind: 'number' },
  { envVar: 'HARNESS_PERMISSION_MODE', key: 'permissionMode', kind: 'string' },
  { envVar: 'HARNESS_MEMORY_FILES', key: 'memoryFiles', kind: 'list' }
];

async function defaultReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return null;
    }
    throw new HarnessError('config_unreadable', `cannot read config file: ${path}`, { cause });
  }
}

function parseLayer(value: unknown, origin: string): PartialConfig {
  const result = PartialConfigSchema.safeParse(value);
  if (!result.success) {
    throw new HarnessError('config_invalid', `invalid config from ${origin}`, {
      details: result.error.issues
    });
  }
  return result.data;
}

async function loadFileLayer(
  path: string,
  origin: string,
  readTextFile: (path: string) => Promise<string | null>
): Promise<PartialConfig | null> {
  const raw = await readTextFile(path);
  if (raw === null) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new HarnessError('config_invalid', `malformed JSON in ${origin} config: ${path}`, {
      cause
    });
  }
  return parseLayer(json, `${origin} config (${path})`);
}

function envLayer(env: Record<string, string | undefined>): PartialConfig {
  const collected: Record<string, unknown> = {};
  for (const { envVar, key, kind } of ENV_KEY_MAP) {
    const raw = env[envVar];
    if (raw === undefined || raw === '') {
      continue;
    }
    if (kind === 'number') {
      collected[key] = Number(raw);
    } else if (kind === 'list') {
      collected[key] = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    } else {
      collected[key] = raw;
    }
  }
  return parseLayer(collected, 'environment (HARNESS_*)');
}

export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const userPath = options.userConfigPath ?? join(homedir(), '.harness', 'config.json');
  const projectPath = options.projectConfigPath ?? join(options.cwd, '.harness', 'config.json');

  const layers: Array<{ layer: ConfigLayer; values: PartialConfig }> = [];
  const userValues = await loadFileLayer(userPath, 'user', readTextFile);
  if (userValues) {
    layers.push({ layer: 'user', values: userValues });
  }
  const projectValues = await loadFileLayer(projectPath, 'project', readTextFile);
  if (projectValues) {
    layers.push({ layer: 'project', values: projectValues });
  }
  layers.push({ layer: 'env', values: envLayer(options.env ?? {}) });
  layers.push({ layer: 'flag', values: parseLayer(options.flags ?? {}, 'flags') });

  const overrides: Record<string, unknown> = {};
  const sources = Object.fromEntries(CONFIG_KEYS.map((key) => [key, 'default'])) as Record<
    keyof Config,
    ConfigLayer
  >;

  for (const { layer, values } of layers) {
    for (const key of CONFIG_KEYS) {
      const value = values[key];
      if (value === undefined) {
        continue;
      }
      // Object-valued keys merge field-by-field so a layer can change one
      // setting without restating the others; scalars and arrays replace.
      overrides[key] = isNestedConfigKey(key)
        ? {
            ...((overrides[key] as object | undefined) ?? CONFIG_DEFAULTS[key]),
            ...(value as object)
          }
        : value;
      sources[key] = layer;
    }
  }

  return { config: ConfigSchema.parse({ ...CONFIG_DEFAULTS, ...overrides }), sources };
}
