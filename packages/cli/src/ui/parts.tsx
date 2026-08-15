import { Box, Text } from 'ink';

import type { SlashCommand } from '../state/slash.ts';
import type {
  PendingPermission,
  ToolLine,
  TranscriptItem,
  ViewModel
} from '../state/view-model.ts';
import {
  compactTokens,
  contextPercent,
  diffPreview,
  fitSegments,
  formatCost,
  formatDuration,
  middleEllipsis,
  type Segment,
  tildePath,
  toolRowText
} from './format.ts';
import { type Block, parseMarkdown, type Span } from './markdown.ts';
import { MODE_DISPLAY, theme } from './theme.ts';

/**
 * Presentational components: props in, frames out. Density is the point —
 * chrome is thin, colour is reserved for state, and nothing is boxed unless
 * it demands a decision from the user (permission prompts).
 */

export function Separator({ columns }: { columns: number }): React.ReactElement {
  return <Text dimColor>{theme.glyph.separator.repeat(Math.max(8, columns))}</Text>;
}

// ---------------------------------------------------------------- header

export function Header({
  vm,
  version,
  columns
}: {
  vm: ViewModel;
  version: string;
  columns: number;
}): React.ReactElement {
  const cwd = middleEllipsis(tildePath(vm.workspaceRoot), Math.max(20, columns - 24));
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.color.accent}>
          harness
        </Text>
        <Text dimColor> v{version} </Text>
        <Text dimColor>{theme.glyph.bullet} </Text>
        <Text color={theme.color.muted}>{vm.model}</Text>
        {vm.memoryFiles.length > 0 ? (
          <Text dimColor>
            {' '}
            {theme.glyph.bullet} memory: {vm.memoryFiles.join(', ')}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text dimColor>{cwd}</Text>
        {vm.gitBranch !== null ? <Text dimColor> ⎇ {vm.gitBranch}</Text> : null}
        {/* Only shown when ON: an always-present "unsandboxed" badge would
            become wallpaper, and this must read as a live state change. */}
        {vm.sandbox.enabled ? (
          <Text color={theme.color.ok}>
            {' '}
            {theme.glyph.bullet} sandboxed
            {vm.sandbox.allowedDomains.length === 0
              ? ' (no network)'
              : ` (${vm.sandbox.allowedDomains.length} domain${
                  vm.sandbox.allowedDomains.length === 1 ? '' : 's'
                })`}
          </Text>
        ) : null}
      </Box>
      <Separator columns={columns} />
    </Box>
  );
}

/** One dim line, not a hollow box: the session has not started yet. */
export function EmptyState(): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        Ask anything {theme.glyph.bullet} /help {theme.glyph.bullet} shift+tab cycles permission
        mode
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------- markdown

function Inline({ spans }: { spans: Span[] }): React.ReactElement {
  return (
    <Text>
      {spans.map((span, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
          key={`${index}-${span.text.slice(0, 8)}`}
          bold={span.bold === true}
          italic={span.italic === true}
          {...(span.code === true && { color: theme.color.accent })}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

function MarkdownBlock({ block }: { block: Block }): React.ReactElement | null {
  switch (block.kind) {
    case 'blank':
      return <Text> </Text>;
    case 'heading':
      return (
        <Text bold color={theme.color.accent}>
          <Inline spans={block.spans} />
        </Text>
      );
    case 'bullet':
      return (
        <Box marginLeft={block.indent * 2}>
          <Text dimColor>{block.marker} </Text>
          <Inline spans={block.spans} />
        </Box>
      );
    case 'code':
      return (
        <Box flexDirection="column" marginLeft={2}>
          {block.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
            <Text key={`${index}-${line.slice(0, 8)}`}>
              <Text dimColor>{'│ '}</Text>
              <Text color={theme.color.accent}>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    case 'paragraph':
      return <Inline spans={block.spans} />;
    default: {
      const exhaustive: never = block;
      throw new Error(`unhandled block: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function Markdown({ source }: { source: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {parseMarkdown(source).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
        <MarkdownBlock key={`${index}-${block.kind}`} block={block} />
      ))}
    </Box>
  );
}

/**
 * A diff is evidence, not the result. Past this many lines it stops being
 * scannable and starts burying the conversation, so the tail is withheld —
 * the full patch is still in the JSONL transcript.
 */
const DIFF_PREVIEW_LINES = 16;

export function Diff({
  text,
  columns,
  maxLines = DIFF_PREVIEW_LINES
}: {
  text: string;
  columns?: number;
  maxLines?: number;
}): React.ReactElement | null {
  const width = columns === undefined ? undefined : Math.max(20, columns - 4);
  const { lines, hidden, collapsed } = diffPreview(text, maxLines);
  if (collapsed) {
    return null;
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, index) => {
        const color = line.startsWith('+')
          ? theme.color.diffAdd
          : line.startsWith('-')
            ? theme.color.diffRemove
            : line.startsWith('@@')
              ? theme.color.diffHunk
              : undefined;
        const shown = width === undefined ? line : middleEllipsis(line, width);
        return (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
            key={`${index}-${line.slice(0, 10)}`}
            {...(color !== undefined ? { color } : { dimColor: true })}
          >
            {shown === '' ? ' ' : shown}
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor>
          … {hidden} more diff line{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------- transcript rows

/**
 * A tool call is ONE line when it has nothing to show:
 *   ✓ read  src/index.ts · 12ms
 * Detail (a diff, an error, live output) is indented underneath only when it
 * exists, so a long session stays scannable.
 */
export function ToolRow({
  line,
  now,
  columns
}: {
  line: ToolLine;
  now?: number | undefined;
  columns?: number | undefined;
}): React.ReactElement {
  const running = line.status === 'running';
  const glyph = running
    ? theme.glyph.running
    : line.status === 'ok'
      ? theme.glyph.ok
      : theme.glyph.error;
  const color = running
    ? theme.color.running
    : line.status === 'ok'
      ? theme.color.ok
      : theme.color.error;
  const elapsed = running
    ? formatDuration(Math.max(0, (now ?? Date.now()) - line.startedAt))
    : formatDuration(line.durationMs);
  const width = columns ?? 80;
  const { label, detail } = toolRowText(line);
  const shownLabel = middleEllipsis(label, Math.max(16, Math.floor((width - 28) * 0.6)));
  // The result belongs on the row itself — a failure is the exception, because
  // its message is long enough to need the block below.
  const shownDetail =
    line.status !== 'error' && detail !== null
      ? middleEllipsis(detail, Math.max(12, Math.floor((width - 28) * 0.4)))
      : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{glyph} </Text>
        <Text bold>{line.tool.padEnd(6)}</Text>
        {shownLabel === '' ? null : <Text> {shownLabel}</Text>}
        {shownDetail !== null ? (
          <Text dimColor>
            {' '}
            {theme.glyph.bullet} {shownDetail}
          </Text>
        ) : null}
        <Text dimColor>
          {' '}
          {theme.glyph.bullet} {elapsed}
        </Text>
      </Box>
      {line.display !== undefined ? <Diff text={line.display} columns={width} /> : null}
      {line.status === 'error' && line.summary !== '' ? (
        <Box marginLeft={2}>
          <Text color={theme.color.error}>{middleEllipsis(line.summary, width - 4)}</Text>
        </Box>
      ) : null}
      {running && line.progress !== '' ? (
        <Box marginLeft={2} flexDirection="column">
          {line.progress
            .split('\n')
            .filter((chunk) => chunk !== '')
            .slice(-3)
            .map((chunk, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
              <Text key={`${index}-${chunk.slice(0, 8)}`} dimColor>
                {middleEllipsis(chunk, width - 4)}
              </Text>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function TranscriptLine({
  item,
  columns
}: {
  item: TranscriptItem;
  columns?: number | undefined;
}): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={theme.color.accent} bold>
            {theme.glyph.prompt}{' '}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Markdown source={item.text} />
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <Text dimColor italic>
            {item.text}
          </Text>
        </Box>
      );
    case 'tool':
      return (
        <Box marginTop={1}>
          <ToolRow line={item.line} columns={columns} />
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={item.severity === 'warning' ? theme.color.warning : theme.color.error}>
            {item.severity === 'warning' ? '! ' : `${theme.glyph.error} `}
            {item.code}:{' '}
          </Text>
          <Text>{item.message}</Text>
        </Box>
      );
    // Meta, not conversation: dimmed and gutter-marked so it never reads as
    // something the model said.
    case 'notice':
      return (
        <Box marginTop={1} flexDirection="column">
          {item.text.split('\n').map((text, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered
              key={`${index}-${text.slice(0, 8)}`}
              dimColor
            >
              {index === 0 ? `${theme.glyph.bullet} ` : '  '}
              {text === '' ? ' ' : text}
            </Text>
          ))}
        </Box>
      );
    default: {
      const exhaustive: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------- prompts

/** The one thing that stays boxed: it demands a decision. */
export function PermissionDialog({ pending }: { pending: PendingPermission }): React.ReactElement {
  return (
    // Hugs its content: a full-width hollow box reads as decoration, and this
    // is the one element that must read as a question.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.color.warning}
      paddingX={1}
      marginTop={1}
      alignSelf="flex-start"
    >
      <Box>
        <Text bold color={theme.color.warning}>
          permission required
        </Text>
        <Text dimColor>
          {' '}
          {theme.glyph.bullet} {pending.tool}
        </Text>
      </Box>
      <Text>{pending.title}</Text>
      {pending.effects.map((effect) => (
        <Text key={`${effect.kind}-${effect.path ?? effect.command ?? ''}`} dimColor>
          {effect.kind} {effect.path ?? effect.command ?? ''}
        </Text>
      ))}
      {pending.suggestions.length > 0 ? (
        <Text dimColor>rule: {pending.suggestions[0] ?? ''}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.color.ok} bold>
          y
        </Text>
        <Text dimColor> once </Text>
        <Text color={theme.color.ok} bold>
          a
        </Text>
        <Text dimColor> session </Text>
        <Text color={theme.color.error} bold>
          n
        </Text>
        <Text dimColor> deny</Text>
      </Box>
    </Box>
  );
}

export function SlashMenu({
  commands,
  selected
}: {
  commands: readonly SlashCommand[];
  selected: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {commands.map((command, index) => (
        <Text key={command.name} {...(index === selected ? { inverse: true } : {})}>
          <Text color={theme.color.accent}>/{command.name.padEnd(9)}</Text>
          <Text dimColor> {command.summary}</Text>
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------- input + footer

export function InputBox({
  value,
  cursor,
  disabled,
  placeholder,
  busy
}: {
  value: string;
  cursor: number;
  disabled: boolean;
  placeholder: string;
  busy?: boolean | undefined;
}): React.ReactElement {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? theme.color.muted : theme.color.accent}
      paddingX={1}
      width="100%"
    >
      <Text color={disabled ? theme.color.muted : theme.color.accent}>{theme.glyph.prompt} </Text>
      {/* The cursor cell is always occupied, so text never shifts by a column
          when the prompt takes the keyboard. */}
      {value === '' ? (
        <Text>
          {disabled ? <Text> </Text> : <Text inverse> </Text>}
          <Text dimColor>{busy === true ? 'running… (esc to interrupt)' : placeholder}</Text>
        </Text>
      ) : (
        <Text>
          {before}
          {/* Highlighting the cursor cell must not consume the character under
              it — a frozen prompt still shows every character typed. */}
          {disabled ? at : <Text inverse>{at === '' || at === '\n' ? ' ' : at}</Text>}
          {at === '\n' ? '\n' : ''}
          {after}
        </Text>
      )}
    </Box>
  );
}

/**
 * One dense status line: permission mode on the left, live session numbers on
 * the right. Everything here is state the user is steering by, so the full
 * token/cache breakdown lives in /cost and /status instead of wrapping this.
 */
export function Footer({
  vm,
  spinnerFrame,
  now,
  columns = 80
}: {
  vm: ViewModel;
  spinnerFrame?: string | undefined;
  now?: number | undefined;
  columns?: number | undefined;
}): React.ReactElement {
  const mode = MODE_DISPLAY[vm.permissionMode];
  const tokens = vm.usage.inputTokens + vm.usage.outputTokens;
  const ctx = contextPercent(vm.contextTokens, vm.model);
  const elapsed =
    vm.turnStartedAt !== null
      ? formatDuration(Math.max(0, (now ?? Date.now()) - vm.turnStartedAt))
      : null;

  // The mode is never dropped — it is the one thing that says what this
  // session will do without asking.
  const left = `${theme.glyph.mode} ${mode.label}`;
  const showDetail = columns >= 72;
  const leftRest = showDetail
    ? ` ${theme.glyph.bullet} ${mode.detail} (shift+tab)`
    : ' (shift+tab)';

  // Nothing has happened yet at turn 0; "turn 0 · $0.0000" is noise, not status.
  const segments: Segment[] = [
    { text: vm.turn > 0 ? `turn ${vm.turn}` : '', priority: 4 },
    { text: elapsed ?? '', priority: 5 },
    { text: vm.queued.length > 0 ? `${vm.queued.length} queued` : '', priority: 6 },
    { text: vm.usage.costUsd > 0 ? formatCost(vm.usage.costUsd) : '', priority: 3 },
    { text: ctx > 0 ? `${ctx}% ctx` : '', priority: 2 },
    { text: tokens > 0 ? `${compactTokens(tokens)} tok` : '', priority: 1 }
  ];
  const right = fitSegments(segments, Math.max(12, columns - (left.length + leftRest.length) - 4));

  return (
    <Box width={columns} justifyContent="space-between">
      <Box>
        <Text color={mode.color}>{left}</Text>
        <Text dimColor>{leftRest}</Text>
      </Box>
      <Box>
        {spinnerFrame !== undefined ? (
          <Text color={theme.color.accent}>{spinnerFrame} </Text>
        ) : null}
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  );
}

export { compactTokens } from './format.ts';
