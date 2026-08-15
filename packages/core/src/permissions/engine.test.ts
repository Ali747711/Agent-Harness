import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '../config/schema.ts';
import { isHarnessError } from '../errors/index.ts';
import type { PermissionEffect, PermissionRequest } from '../protocol/types.ts';
import { PermissionEngine, suggestRules } from './engine.ts';
import { parseRule } from './rules.ts';

function req(tool: string, effects: PermissionEffect[]): PermissionRequest {
  return { tool, title: `${tool} request`, effects };
}

const read = (path: string): PermissionEffect => ({ kind: 'read', path });
const write = (path: string): PermissionEffect => ({ kind: 'write', path });
const exec = (command: string): PermissionEffect => ({ kind: 'execute', command });

function engine(mode: PermissionMode, allow: string[] = [], deny: string[] = []): PermissionEngine {
  return new PermissionEngine({ mode, allow, deny });
}

describe('PermissionEngine decision table', () => {
  // [name, mode, allow, deny, request, expected kind]
  const table: Array<[string, PermissionMode, string[], string[], PermissionRequest, string]> = [
    ['default: read allows', 'default', [], [], req('read', [read('src/a.ts')]), 'allow'],
    ['default: write asks', 'default', [], [], req('write', [write('src/a.ts')]), 'ask'],
    ['default: execute asks', 'default', [], [], req('bash', [exec('git status')]), 'ask'],
    ['acceptEdits: write allows', 'acceptEdits', [], [], req('write', [write('a.ts')]), 'allow'],
    ['acceptEdits: execute still asks', 'acceptEdits', [], [], req('bash', [exec('ls')]), 'ask'],
    ['bypass: write allows', 'bypass', [], [], req('write', [write('a.ts')]), 'allow'],
    ['bypass: execute allows', 'bypass', [], [], req('bash', [exec('rm -rf /tmp/x')]), 'allow'],
    ['deny rule beats bypass', 'bypass', [], ['bash'], req('bash', [exec('echo hi')]), 'deny'],
    [
      'deny rule beats allow rule',
      'default',
      ['bash'],
      ['bash(rm:*)'],
      req('bash', [exec('rm -rf node_modules')]),
      'deny'
    ],
    [
      'command prefix rule allows',
      'default',
      ['bash(git status:*)'],
      [],
      req('bash', [exec('git status --short')]),
      'allow'
    ],
    [
      'prefix requires a word boundary',
      'default',
      ['bash(git status:*)'],
      [],
      req('bash', [exec('git statusx')]),
      'ask'
    ],
    [
      'exact command rule allows only the exact command',
      'default',
      ['bash(git status)'],
      [],
      req('bash', [exec('git status --short')]),
      'ask'
    ],
    [
      'path glob scopes writes: inside',
      'default',
      ['write(src/**)'],
      [],
      req('write', [write('src/deep/file.ts')]),
      'allow'
    ],
    [
      'path glob scopes writes: outside',
      'default',
      ['write(src/**)'],
      [],
      req('write', [write('README.md')]),
      'ask'
    ],
    [
      'single star stays within a segment',
      'default',
      ['write(*.md)'],
      [],
      req('write', [write('docs/notes.md')]),
      'ask'
    ],
    [
      'single star matches at root level',
      'default',
      ['write(*.md)'],
      [],
      req('write', [write('README.md')]),
      'allow'
    ],
    [
      'tool-wide deny blocks even reads',
      'default',
      [],
      ['read'],
      req('read', [read('src/a.ts')]),
      'deny'
    ],
    [
      'multi-effect: the worst effect wins (ask)',
      'default',
      [],
      [],
      req('edit', [read('a.ts'), write('a.ts')]),
      'ask'
    ],
    [
      'multi-effect: any denied effect denies the request',
      'acceptEdits',
      [],
      ['edit(secrets/**)'],
      req('edit', [read('secrets/key.pem'), write('secrets/key.pem')]),
      'deny'
    ],
    [
      'rules are tool-scoped: a write() rule does not cover the edit tool',
      'acceptEdits',
      [],
      ['write(secrets/**)'],
      req('edit', [write('secrets/key.pem')]),
      'allow'
    ],
    ['no effects: pure computation allows', 'default', [], [], req('noop', []), 'allow']
  ];

  it.each(table)('%s', (_name, mode, allow, deny, request, expected) => {
    expect(engine(mode, allow, deny).evaluate(request).kind).toBe(expected);
  });

  it('attributes decisions to the matched rule', () => {
    const decision = engine('default', [], ['bash(rm:*)']).evaluate(
      req('bash', [exec('rm -rf x')])
    );
    expect(decision).toMatchObject({ kind: 'deny', matchedRule: 'bash(rm:*)' });
  });

  it('session grants allow repeats of the exact effect only', () => {
    const e = engine('default');
    const request = req('write', [write('src/a.ts')]);
    expect(e.evaluate(request).kind).toBe('ask');

    e.recordGrant(request);
    expect(e.evaluate(request).kind).toBe('allow');
    expect(e.evaluate(req('write', [write('src/b.ts')])).kind).toBe('ask');
    expect(e.evaluate(req('bash', [exec('src/a.ts')])).kind).toBe('ask');
  });
});

describe('parseRule', () => {
  it('parses the four matcher shapes', () => {
    expect(parseRule('read').matcher).toEqual({ type: 'any' });
    expect(parseRule('bash(git status:*)').matcher).toEqual({
      type: 'command-prefix',
      prefix: 'git status'
    });
    expect(parseRule('bash(git status)').matcher).toEqual({
      type: 'command-exact',
      command: 'git status'
    });
    expect(parseRule('write(src/**)').matcher).toMatchObject({ type: 'path', pattern: 'src/**' });
    expect(parseRule('write(README.md)').matcher).toMatchObject({
      type: 'path',
      pattern: 'README.md'
    });
  });

  it('rejects malformed rules with config_invalid', () => {
    for (const bad of ['', 'Bash(', '(x)', 'BASH', 'bash()', 'bash(:*)']) {
      try {
        parseRule(bad);
        expect.unreachable(`should have rejected: ${bad}`);
      } catch (error) {
        if (!isHarnessError(error)) {
          throw error;
        }
        expect(error.code).toBe('config_invalid');
      }
    }
  });

  it('path regexes escape special characters', () => {
    const rule = parseRule('read(a+b.ts)');
    if (rule.matcher.type !== 'path') {
      expect.unreachable('expected a path matcher');
    }
    expect(rule.matcher.regex.test('a+b.ts')).toBe(true);
    expect(rule.matcher.regex.test('aab.ts')).toBe(false);
    expect(rule.matcher.regex.test('a+bxts')).toBe(false);
  });
});

describe('suggestRules', () => {
  it('suggests prefix rules for commands and path rules for files', () => {
    expect(suggestRules(req('bash', [exec('git commit -m x')]))).toEqual(['bash(git commit:*)']);
    expect(suggestRules(req('write', [write('src/a.ts')]))).toEqual(['write(src/a.ts)']);
  });
});
