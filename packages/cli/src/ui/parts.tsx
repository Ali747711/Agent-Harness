import { Box, Text } from 'ink';
import type { SlashCommand } from '../state/slash.ts';
import type {
  PendingPermission,
  ToolLine,
  TranscriptItem,
  ViewModel
} from '../state/view-model.ts';
import { type Block, parseMarkdown, type Span } from './markdown.ts';
import { compactTokens, formatDuration, theme } from './theme.ts';

/**
 * Presentational components. Props in, frames out — every decision that is not
 * purely visual lives in the reducer or the controller, so these need only
 * smoke coverage.
 */

/** A titled rounded box; the building block of the panel layout. */
export function Panel({
  title,
  badge,
  color,
  children
}: {
  title: string;
  badge?: string | undefined;
  color: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
      <Box>
        <Text color={color} bold>
          {title}
        </Text>
        {badge !== undefined && badge !== '' ? <Text dimColor> · {badge}</Text> : null}
      </Box>
      {children}
    </Box>
  );
}

function Inline({ spans }: { spans: Span[] }): React.ReactElement {
  return (
    <Text>
      {spans.map((span, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered or filtered
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
        <Box marginTop={1}>
          <Text bold color={theme.color.accent}>
            <Inline spans={block.spans} />
          </Text>
        </Box>
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
        <Box flexDirection="column" marginY={0} marginLeft={1}>
          {block.language !== '' ? <Text dimColor>{block.language}</Text> : null}
          {block.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered or filtered
            <Text key={`${index}-${line.slice(0, 8)}`} color={theme.color.accent}>
              {'│ '}
              <Text color="white">{line}</Text>
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
  const blocks = parseMarkdown(source);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered or filtered
        <MarkdownBlock key={`${index}-${block.kind}`} block={block} />
      ))}
    </Box>
  );
}

/** Unified diff with +/- colouring; the payoff of the tool `display` field. */
export function Diff({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) => {
        const color = line.startsWith('+')
          ? theme.color.added
          : line.startsWith('-')
            ? theme.color.removed
            : line.startsWith('@@')
              ? theme.color.hunk
              : undefined;
        return (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: positional render product, never reordered or filtered
            key={`${index}-${line.slice(0, 10)}`}
            {...(color !== undefined ? { color } : { dimColor: true })}
          >
            {line === '' ? ' ' : line}
          </Text>
        );
      })}
    </Box>
  );
}

export function ToolPanel({
  line,
  now
}: {
  line: ToolLine;
  now?: number | undefined;
}): React.ReactElement {
  const running = line.status === 'running';
  const color = running
    ? theme.color.toolRunning
    : line.status === 'ok'
      ? theme.color.ok
      : theme.color.error;
  const elapsed = running
    ? formatDuration(Math.max(0, (now ?? Date.now()) - line.startedAt))
    : formatDuration(line.durationMs);

  return (
    <Panel title={line.tool} badge={`${line.title}  ${elapsed}`} color={color}>
      {line.display !== undefined ? <Diff text={line.display} /> : null}
      {line.display === undefined && !running && line.summary !== '' ? (
        <Text dimColor>{line.summary}</Text>
      ) : null}
      {running && line.progress !== '' ? (
        <Text dimColor>{line.progress.split('\n').slice(-4).join('\n')}</Text>
      ) : null}
    </Panel>
  );
}

export function TranscriptLine({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return (
        <Panel title={theme.label.user} color={theme.color.user}>
          <Text>{item.text}</Text>
        </Panel>
      );
    case 'assistant':
      return (
        <Panel title={theme.label.assistant} color={theme.color.assistant}>
          <Markdown source={item.text} />
        </Panel>
      );
    case 'thinking':
      return (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor italic>
            {item.text}
          </Text>
        </Box>
      );
    case 'tool':
      return <ToolPanel line={item.line} />;
    case 'error':
      return (
        <Panel
          title={item.severity === 'warning' ? 'warning' : 'error'}
          badge={item.code}
          color={item.severity === 'warning' ? theme.color.warning : theme.color.error}
        >
          <Text>{item.message}</Text>
        </Panel>
      );
    case 'notice':
      return (
        <Box marginLeft={1}>
          <Text dimColor>· {item.text}</Text>
        </Box>
      );
    default: {
      const exhaustive: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function PermissionDialog({ pending }: { pending: PendingPermission }): React.ReactElement {
  return (
    <Panel title="permission required" badge={pending.tool} color={theme.color.permission}>
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
        <Text>
          <Text color={theme.color.ok} bold>
            y
          </Text>
          <Text dimColor> allow once · </Text>
          <Text color={theme.color.ok} bold>
            a
          </Text>
          <Text dimColor> allow for session · </Text>
          <Text color={theme.color.error} bold>
            n
          </Text>
          <Text dimColor> deny</Text>
        </Text>
      </Box>
    </Panel>
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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.muted} paddingX={1}>
      {commands.map((command, index) => (
        <Text key={command.name} inverse={index === selected}>
          <Text color={theme.color.accent}>/{command.name.padEnd(9)}</Text>
          <Text dimColor> {command.summary}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function Banner({ vm }: { vm: ViewModel }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.accent} paddingX={1}>
      <Text bold color={theme.color.accent}>
        harness
      </Text>
      <Text dimColor>{vm.workspaceRoot}</Text>
      <Text dimColor>
        {vm.model}
        {vm.memoryFiles.length > 0 ? ` · memory: ${vm.memoryFiles.join(', ')}` : ''}
      </Text>
      <Text dimColor>/help for commands · ctrl-c to interrupt</Text>
    </Box>
  );
}

/** Multi-line aware input with a visible caret. */
export function InputLine({
  value,
  cursor,
  disabled
}: {
  value: string;
  cursor: number;
  disabled: boolean;
}): React.ReactElement {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  return (
    <Box>
      <Text color={disabled ? theme.color.muted : theme.color.user}>{'› '}</Text>
      <Text>
        {before}
        {disabled ? null : <Text inverse>{at === '' || at === '\n' ? ' ' : at}</Text>}
        {at === '\n' ? '\n' : ''}
        {after}
      </Text>
    </Box>
  );
}

export function StatusBar({
  vm,
  spinnerFrame,
  now
}: {
  vm: ViewModel;
  spinnerFrame?: string | undefined;
  now?: number | undefined;
}): React.ReactElement {
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = vm.usage;
  const tokens = inputTokens + outputTokens;
  const elapsed =
    vm.turnStartedAt !== null
      ? formatDuration(Math.max(0, (now ?? Date.now()) - vm.turnStartedAt))
      : null;

  return (
    <Box>
      <Text dimColor>
        {vm.status === 'working' && spinnerFrame !== undefined ? `${spinnerFrame} ` : ''}
        {vm.model} · turn {vm.turn} · {compactTokens(tokens)} tok
        {cacheReadInputTokens > 0 ? ` · ${compactTokens(cacheReadInputTokens)} cached` : ''}
        {cacheCreationInputTokens > 0
          ? ` · ${compactTokens(cacheCreationInputTokens)} written`
          : ''}
        {' · '}${vm.usage.costUsd.toFixed(4)}
        {elapsed !== null ? ` · ${elapsed}` : ''}
        {vm.queued.length > 0 ? ` · ${vm.queued.length} queued` : ''}
        {vm.status === 'working' ? ' · esc to interrupt' : ''}
      </Text>
    </Box>
  );
}

export { compactTokens } from './theme.ts';
