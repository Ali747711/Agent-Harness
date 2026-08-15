import { Box, Text } from 'ink';

import type {
  PendingPermission,
  ToolLine,
  TranscriptItem,
  ViewModel
} from '../state/view-model.ts';

/**
 * Dumb presentational components: props in, frames out. All state lives in the
 * reducer (step 13), so these need only smoke coverage.
 */

export function TranscriptLine({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan">{'> '}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
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
      return <ToolStatus line={item.line} />;
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={item.severity === 'warning' ? 'yellow' : 'red'}>
            {item.severity === 'warning' ? '! ' : '✗ '}
            {item.code}: {item.message}
          </Text>
        </Box>
      );
    case 'notice':
      return (
        <Text dimColor>
          {'· '}
          {item.text}
        </Text>
      );
    default: {
      const exhaustive: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function ToolStatus({ line }: { line: ToolLine }): React.ReactElement {
  const mark = line.status === 'running' ? '◐' : line.status === 'ok' ? '✓' : '✗';
  const color = line.status === 'error' ? 'red' : line.status === 'ok' ? 'green' : 'yellow';
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{mark} </Text>
        <Text bold>{line.tool}</Text>
        <Text> {line.title}</Text>
        {line.status !== 'running' && line.summary !== '' ? (
          <Text dimColor> — {line.summary}</Text>
        ) : null}
      </Box>
      {line.status === 'running' && line.progress !== '' ? (
        <Box marginLeft={2}>
          <Text dimColor>{line.progress.split('\n').slice(-3).join('\n')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function PermissionDialog({ pending }: { pending: PendingPermission }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>
        {pending.tool}: {pending.title}
      </Text>
      {pending.effects.map((effect) => (
        <Text key={`${effect.kind}-${effect.path ?? effect.command ?? ''}`} dimColor>
          {'  '}
          {effect.kind} {effect.path ?? effect.command ?? ''}
        </Text>
      ))}
      {pending.suggestions.length > 0 ? (
        <Text dimColor>{`  rule: ${pending.suggestions[0] ?? ''}`}</Text>
      ) : null}
      <Text>
        <Text color="green">y</Text> allow once · <Text color="green">a</Text> allow for session ·{' '}
        <Text color="red">n</Text> deny
      </Text>
    </Box>
  );
}

/** 17927 → "17.9k" so the status bar stays one line. */
export function compactTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  return `${(count / 1000).toFixed(1)}k`;
}

export function StatusBar({ vm }: { vm: ViewModel }): React.ReactElement {
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = vm.usage;
  const tokens = inputTokens + outputTokens;
  // Cache writes are billed at 1.25x input, so omitting them makes the cost
  // look impossible next to a small token count.
  return (
    <Box>
      <Text dimColor>
        {vm.model} · turn {vm.turn} · {compactTokens(tokens)} tok
        {cacheReadInputTokens > 0 ? ` · ${compactTokens(cacheReadInputTokens)} cached` : ''}
        {cacheCreationInputTokens > 0
          ? ` · ${compactTokens(cacheCreationInputTokens)} written`
          : ''}{' '}
        · ${vm.usage.costUsd.toFixed(4)}
        {vm.queued.length > 0 ? ` · ${vm.queued.length} queued` : ''}
        {vm.status === 'working' ? ' · working…' : ''}
      </Text>
    </Box>
  );
}

export function InputLine({
  value,
  disabled
}: {
  value: string;
  disabled: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Text color={disabled ? 'gray' : 'cyan'}>{'> '}</Text>
      <Text>{value}</Text>
      {disabled ? null : <Text inverse> </Text>}
    </Box>
  );
}
