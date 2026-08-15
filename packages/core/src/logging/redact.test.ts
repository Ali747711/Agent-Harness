import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redact.ts';

describe('redactSecrets', () => {
  it.each([
    ['api error 401: invalid x-api-key sk-ant-api03-AbCdEf123456_xyz-QQ', 'sk-ant-api03'],
    ['token ghp_0123456789abcdefghijklmnop', 'ghp_0123'],
    ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234'],
    ['Authorization: Bearer abcdef0123456789ABCDEF==', 'abcdef0123456789'],
    ['{"api_key": "abcdef0123456789xyz"}', 'abcdef0123456789'],
    ['password = hunter2hunter2hunter2', 'hunter2hunter2']
  ])('masks %s', (input, leaked) => {
    const output = redactSecrets(input);
    expect(output).not.toContain(leaked);
    expect(output).toContain('redacted');
  });

  it('leaves ordinary text alone', () => {
    const text = 'command failed (exit 1): src/index.ts:42 expected 3 to be 4';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does not mangle short non-secret tokens', () => {
    expect(redactSecrets('sk-1')).toBe('sk-1');
    expect(redactSecrets('the secret: x')).toBe('the secret: x');
  });
});
