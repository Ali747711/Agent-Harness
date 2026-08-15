import { describe, expect, it } from 'vitest';

import { stripPort } from './doctor.ts';

describe('stripPort', () => {
  it('drops an optional :port suffix from an allowlist entry', () => {
    expect(stripPort('example.com')).toBe('example.com');
    expect(stripPort('api.example.com:443')).toBe('api.example.com');
    expect(stripPort('*.example.com:8443')).toBe('*.example.com');
  });

  it('keeps bracketed IPv6 literals intact', () => {
    // An unbracketed multi-colon entry is ambiguous, which is why the runtime
    // requires brackets; the colon inside them is not a port separator.
    expect(stripPort('[::1]')).toBe('[::1]');
    expect(stripPort('[2001:db8::1]:443')).toBe('[2001:db8::1]');
  });
});
