import { describe, expect, it } from 'vitest';

import {
  compactTokens,
  contextPercent,
  contextWindow,
  diffPreview,
  fitSegments,
  formatCost,
  formatDuration,
  middleEllipsis,
  stripToolVerb,
  tildePath,
  toolRowText
} from './format.ts';

describe('format helpers', () => {
  it('abbreviates token counts across magnitudes', () => {
    expect(compactTokens(0)).toBe('0');
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(17_927)).toBe('17.9k');
    expect(compactTokens(1_250_000)).toBe('1.3M');
  });

  it('formats durations from ms to minutes', () => {
    expect(formatDuration(12)).toBe('12ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(95_000)).toBe('1m35s');
  });

  it('keeps sub-cent costs precise and larger ones short', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.239)).toBe('$1.24');
  });

  it('replaces the home prefix with ~', () => {
    expect(tildePath('/Users/me/code/app', '/Users/me')).toBe('~/code/app');
    expect(tildePath('/var/tmp/x', '/Users/me')).toBe('/var/tmp/x');
  });

  it('middle-ellipsizes so both ends stay readable', () => {
    expect(middleEllipsis('short', 20)).toBe('short');
    const long = 'packages/core/src/permissions/engine.ts';
    const clipped = middleEllipsis(long, 20);
    expect(clipped).toHaveLength(20);
    expect(clipped).toContain('…');
    expect(clipped.startsWith('packages')).toBe(true);
    expect(clipped.endsWith('.ts')).toBe(true);
  });

  it('knows the context window per model family', () => {
    expect(contextWindow('claude-opus-5')).toBe(1_000_000);
    expect(contextWindow('claude-haiku-4-5')).toBe(200_000);
    // Unknown models fall back to the conservative window.
    expect(contextWindow('some-future-model')).toBe(200_000);
  });

  it('reports context use as a clamped percentage', () => {
    expect(contextPercent(100_000, 'claude-opus-5')).toBe(10);
    expect(contextPercent(0, 'claude-opus-5')).toBe(0);
    expect(contextPercent(5_000_000, 'claude-opus-5')).toBe(100);
  });
});

describe('tool row text', () => {
  it('drops a leading verb that only repeats the tool column', () => {
    expect(stripToolVerb('write', 'Write src/a.ts')).toBe('src/a.ts');
    expect(stripToolVerb('read', 'Read src/a.ts')).toBe('src/a.ts');
    // A title that is only the verb still has to say something.
    expect(stripToolVerb('write', 'Write')).toBe('Write');
    // Free-form titles (bash descriptions) are left alone.
    expect(stripToolVerb('bash', 'run the test suite')).toBe('run the test suite');
  });

  it('splits label from result without repeating the path', () => {
    // write/edit summaries lead with the same path the title carries.
    expect(
      toolRowText({ tool: 'write', title: 'Write app.html', summary: 'app.html  +76 −0' })
    ).toEqual({ label: 'app.html', detail: '+76 −0' });
    expect(toolRowText({ tool: 'read', title: 'Read a.ts', summary: 'read 2 of 2 lines' })).toEqual(
      {
        label: 'a.ts',
        detail: 'read 2 of 2 lines'
      }
    );
    expect(toolRowText({ tool: 'bash', title: 'verify output', summary: '' })).toEqual({
      label: 'verify output',
      detail: null
    });
  });
});

describe('diffPreview', () => {
  const additions = (count: number): string =>
    ['@@ -1,0 +1,1 @@', ...Array.from({ length: count }, (_, i) => `+line ${i}`)].join('\n');

  it('shows a short patch in full', () => {
    const text = ['@@ -1,2 +1,2 @@', '-before', '+after'].join('\n');
    expect(diffPreview(text, 16)).toEqual({
      lines: ['@@ -1,2 +1,2 @@', '-before', '+after'],
      hidden: 0,
      collapsed: false
    });
  });

  it('excerpts a long patch that actually changes something', () => {
    const text = ['@@ -1,40 +1,40 @@', '-gone', ...Array.from({ length: 30 }, () => '+kept')].join(
      '\n'
    );
    const preview = diffPreview(text, 16);
    expect(preview.collapsed).toBe(false);
    expect(preview.lines).toHaveLength(16);
    expect(preview.hidden).toBe(16);
  });

  it('collapses a long run of pure additions — the +N badge already says it', () => {
    const preview = diffPreview(additions(76), 16);
    expect(preview).toEqual({ lines: [], hidden: 77, collapsed: true });
  });
});

describe('fitSegments', () => {
  const segments = [
    { text: 'turn 2', priority: 4 },
    { text: '$0.11', priority: 3 },
    { text: '2% ctx', priority: 2 },
    { text: '1.8k tok', priority: 1 }
  ];

  it('keeps everything when there is room', () => {
    expect(fitSegments(segments, 80)).toBe('turn 2 · $0.11 · 2% ctx · 1.8k tok');
  });

  it('sheds the lowest priority first rather than wrapping', () => {
    expect(fitSegments(segments, 26)).toBe('turn 2 · $0.11 · 2% ctx');
    expect(fitSegments(segments, 15)).toBe('turn 2 · $0.11');
    // Never returns nothing: the highest priority survives any width.
    expect(fitSegments(segments, 1)).toBe('turn 2');
  });

  it('ignores empty segments so callers can pass conditionals inline', () => {
    expect(
      fitSegments(
        [
          { text: 'turn 2', priority: 4 },
          { text: '', priority: 9 }
        ],
        80
      )
    ).toBe('turn 2');
  });
});
