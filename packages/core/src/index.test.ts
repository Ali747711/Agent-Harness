import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from './index.ts';

describe('core package smoke', () => {
  it('exposes a version', () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
