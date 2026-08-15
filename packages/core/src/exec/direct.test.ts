import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isHarnessError } from '../errors/index.ts';
import { DirectCommandRunner, scrubEnv } from './direct.ts';
import type { CommandRunOptions } from './runner.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-exec-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(overrides: Partial<CommandRunOptions> = {}): CommandRunOptions {
  return {
    command: 'true',
    cwd: dir,
    timeoutMs: 10_000,
    maxOutputBytes: 4_000_000,
    signal: new AbortController().signal,
    ...overrides
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scrubEnv', () => {
  it('drops secret-shaped variables and keeps the rest', () => {
    const scrubbed = scrubEnv({
      ANTHROPIC_API_KEY: 'sk-x',
      GITHUB_TOKEN: 't',
      MY_SECRET: 's',
      DB_PASSWORD: 'p',
      AWS_CREDENTIALS: 'c',
      SSH_PRIVATE_KEY: 'k',
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8'
    });
    expect(Object.keys(scrubbed).sort()).toEqual(['HOME', 'LANG', 'PATH']);
  });
});

describe('DirectCommandRunner', () => {
  const runner = new DirectCommandRunner({ PATH: process.env.PATH ?? '', HOME: dir });

  it('runs a command and captures stdout/exit code', async () => {
    const result = await runner.run(options({ command: 'echo hello-runner' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-runner\n');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr and non-zero exits without throwing', async () => {
    const result = await runner.run(options({ command: 'echo oops >&2; exit 3' }));
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('oops\n');
  });

  it('scrubs secret env vars from the child environment', async () => {
    const secretRunner = new DirectCommandRunner({
      PATH: process.env.PATH ?? '',
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
      SAFE_VALUE: 'visible'
    });
    const result = await secretRunner.run(
      options({ command: 'echo "${ANTHROPIC_API_KEY:-none}:${SAFE_VALUE:-none}"' })
    );
    expect(result.stdout.trim()).toBe('none:visible');
  });

  it('kills on timeout and reports timedOut', async () => {
    const started = Date.now();
    const result = await runner.run(options({ command: 'sleep 10', timeoutMs: 200 }));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills the whole process group on abort (no orphaned grandchildren)', async () => {
    const controller = new AbortController();
    const growFile = join(dir, 'grow.txt');
    const pending = runner.run(
      options({
        command: `(while true; do echo x >> ${JSON.stringify(growFile)}; sleep 0.05; done) & wait`,
        signal: controller.signal
      })
    );
    await wait(300);
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'aborted'
    );

    // If the background writer survived, the file would keep growing.
    await wait(300);
    const sizeAfterSettle = (await stat(growFile)).size;
    await wait(400);
    expect((await stat(growFile)).size).toBe(sizeAfterSettle);
  });

  it('streams chunks and enforces the output byte cap', async () => {
    const chunks: string[] = [];
    const result = await runner.run(
      options({
        command: 'echo first; sleep 0.05; echo second; head -c 5000 /dev/zero | tr "\\0" x',
        maxOutputBytes: 1_000,
        onChunk: (chunk) => {
          chunks.push(chunk);
        }
      })
    );
    expect(chunks.join('')).toContain('first\n');
    expect(result.truncated).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run(options({ command: 'echo never', signal: controller.signal }))
    ).rejects.toSatisfy((error: unknown) => isHarnessError(error) && error.code === 'aborted');
  });
});
