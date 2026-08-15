/**
 * Minimal markdown → styled segments for the terminal. Deliberately not a full
 * parser: assistant output is mostly prose with code fences, inline code,
 * emphasis, and lists, and a real parser would cost more than it returns here.
 *
 * Pure and synchronous so it can be unit-tested without rendering.
 */
export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'bullet'; marker: string; spans: Span[]; indent: number }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'blank' };

const FENCE = /^\s*```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

/** Split inline emphasis and code. Unmatched markers stay literal. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, index) });
    }
    const token = match[0];
    if (token.startsWith('`')) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith('**')) {
      spans.push({ text: token.slice(2, -2), bold: true });
    } else {
      spans.push({ text: token.slice(1, -1), italic: true });
    }
    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex) });
  }
  return spans.length > 0 ? spans : [{ text }];
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);

    if (fence !== null) {
      flushParagraph();
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec(lines[index] ?? '') === null) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'code', language, lines: body });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      blocks.push({ kind: 'blank' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        spans: parseInline(heading[2] ?? '')
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      blocks.push({
        kind: 'bullet',
        indent: Math.floor((bullet[1] ?? '').length / 2),
        marker: (bullet[2] ?? '-').endsWith('.') ? (bullet[2] ?? '-') : '•',
        spans: parseInline(bullet[3] ?? '')
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();

  // Collapse leading/trailing blanks; they add nothing inside a panel.
  while (blocks[0]?.kind === 'blank') {
    blocks.shift();
  }
  while (blocks.at(-1)?.kind === 'blank') {
    blocks.pop();
  }
  return blocks;
}
