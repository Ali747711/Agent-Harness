import { describe, expect, it } from 'vitest';

import { isHarnessError } from '../errors/index.ts';
import { type LoadConfigOptions, loadConfig } from './resolve.ts';

/** In-memory file layer — no fs mocking. */
function files(map: Record<string, string>): (path: string) => Promise<string | null> {
  return (path: string) => Promise.resolve(map[path] ?? null);
}

const base: LoadConfigOptions = {
  cwd: '/work/repo',
  userConfigPath: '/home/u/.harness/config.json',
  projectConfigPath: '/work/repo/.harness/config.json',
  env: {},
  readTextFile: files({})
};

describe('loadConfig', () => {
  it('returns documented defaults when nothing is provided', async () => {
    const { config, sources } = await loadConfig(base);
    expect(config).toEqual({
      model: 'claude-opus-5',
      effort: 'xhigh',
      thinking: 'adaptive',
      maxTokens: 32_000,
      maxTurns: 40,
      permissionMode: 'default',
      permissions: { allow: [], deny: [] },
      memoryFiles: ['HARNESS.md', 'AGENTS.md', 'CLAUDE.md']
    });
    expect(Object.values(sources).every((source) => source === 'default')).toBe(true);
  });

  it('applies precedence default < user < project < env < flag', async () => {
    const { config, sources } = await loadConfig({
      ...base,
      readTextFile: files({
        '/home/u/.harness/config.json': JSON.stringify({
          model: 'from-user',
          effort: 'low',
          maxTurns: 10,
          permissionMode: 'acceptEdits'
        }),
        '/work/repo/.harness/config.json': JSON.stringify({
          model: 'from-project',
          effort: 'medium'
        })
      }),
      env: { HARNESS_MODEL: 'from-env' },
      flags: { model: 'from-flag' }
    });

    expect(config.model).toBe('from-flag');
    expect(config.effort).toBe('medium');
    expect(config.maxTurns).toBe(10);
    expect(config.permissionMode).toBe('acceptEdits');
    expect(sources).toMatchObject({
      model: 'flag',
      effort: 'project',
      maxTurns: 'user',
      permissionMode: 'user',
      thinking: 'default'
    });
  });

  it('rejects sampling parameters as unknown keys (ADR-0010)', async () => {
    try {
      await loadConfig({ ...base, flags: { temperature: 0.7 } });
      expect.unreachable('should have thrown');
    } catch (error) {
      if (!isHarnessError(error)) {
        throw error;
      }
      expect(error.code).toBe('config_invalid');
      expect(JSON.stringify(error.details)).toContain('temperature');
    }
  });

  it('rejects unknown keys in a config file with origin attribution', async () => {
    const attempt = loadConfig({
      ...base,
      readTextFile: files({
        '/work/repo/.harness/config.json': JSON.stringify({ top_p: 0.9 })
      })
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('project config')
    });
  });

  it('rejects malformed JSON with the file path in the message', async () => {
    const attempt = loadConfig({
      ...base,
      readTextFile: files({ '/home/u/.harness/config.json': '{ not json' })
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('/home/u/.harness/config.json')
    });
  });

  it('parses numeric and list env vars', async () => {
    const { config, sources } = await loadConfig({
      ...base,
      env: {
        HARNESS_MAX_TOKENS: '4096',
        HARNESS_MEMORY_FILES: 'TEAM.md, CLAUDE.md'
      }
    });
    expect(config.maxTokens).toBe(4096);
    expect(config.memoryFiles).toEqual(['TEAM.md', 'CLAUDE.md']);
    expect(sources.maxTokens).toBe('env');
  });

  it('rejects non-numeric numeric env vars', async () => {
    const attempt = loadConfig({ ...base, env: { HARNESS_MAX_TOKENS: 'lots' } });
    await expect(attempt).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('rejects invalid enum values wherever they come from', async () => {
    const attempt = loadConfig({ ...base, flags: { effort: 'ultra' } });
    await expect(attempt).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('accepts valid permission rules and rejects malformed ones at load time', async () => {
    const { config } = await loadConfig({
      ...base,
      readTextFile: files({
        '/work/repo/.harness/config.json': JSON.stringify({
          permissions: { allow: ['bash(git status:*)', 'write(src/**)'], deny: ['bash(rm:*)'] }
        })
      })
    });
    expect(config.permissions.allow).toHaveLength(2);

    const attempt = loadConfig({
      ...base,
      readTextFile: files({
        '/work/repo/.harness/config.json': JSON.stringify({
          permissions: { allow: ['BASH('], deny: [] }
        })
      })
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('project config')
    });
  });
});
