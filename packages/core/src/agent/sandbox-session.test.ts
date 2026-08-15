import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS } from '../config/schema.ts';
import { probeSandbox } from '../exec/sandbox.ts';
import { MockModelClient } from '../model/mock/client.ts';
import { builtinToolRegistry } from '../tools/index.ts';
import { AgentSession } from './session.ts';

/**
 * End-to-end: config → AgentSession → bash tool → kernel.
 *
 * The runner unit tests prove SandboxedCommandRunner confines a command; this
 * proves the wiring actually reaches it, which is the part a refactor would
 * silently break. Skipped where the platform cannot sandbox rather than
 * passing vacuously.
 */
const status = await probeSandbox();

let workspace: string;

/**
 * The escape target must live outside the DEFAULT policy, and that policy makes
 * $TMPDIR writable so build tools keep working — a temp dir is therefore not an
 * escape at all. $HOME is. (Discovered by this test passing when it should not
 * have: the write into $TMPDIR succeeded, exactly as configured.)
 */
const escapePath = join(homedir(), '.harness-sandbox-session-probe');

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-sbxses-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(escapePath, { force: true });
});

async function runBash(command: string, sandboxEnabled: boolean): Promise<string> {
  const session = new AgentSession({
    config: {
      ...CONFIG_DEFAULTS,
      // bypass: the point is that the OS stops this even when the permission
      // engine does not.
      permissionMode: 'bypass',
      sandbox: { ...CONFIG_DEFAULTS.sandbox, enabled: sandboxEnabled }
    },
    modelClient: new MockModelClient([
      { toolCalls: [{ name: 'bash', input: { command, description: 'probe' } }] },
      { text: 'done' }
    ]),
    workspaceRoot: workspace,
    tools: builtinToolRegistry()
  });

  const summaries: string[] = [];
  for await (const event of session.run('go', new AbortController().signal)) {
    if (event.type === 'tool_call_completed') {
      summaries.push(`${event.ok ? 'ok' : 'err'}:${event.summary}`);
    }
  }
  return summaries.join('|');
}

describe.skipIf(!status.supported)('sandbox reaches the bash tool through the session', () => {
  it('blocks an escape write when sandbox.enabled, even in bypass mode', async () => {
    const summary = await runBash(`echo pwned > ${JSON.stringify(escapePath)}`, true);

    expect(summary).not.toContain('exit 0');
    await expect(readFile(escapePath, 'utf8')).rejects.toThrow();
  }, 60_000);

  it('the same command succeeds with the sandbox off — proving the test is real', async () => {
    // Without this, the assertion above could pass for any unrelated reason.
    const summary = await runBash(`echo through > ${JSON.stringify(escapePath)}`, false);

    expect(summary).toContain('exit 0');
    expect(await readFile(escapePath, 'utf8')).toBe('through\n');
  }, 60_000);
});
