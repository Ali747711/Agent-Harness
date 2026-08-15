import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { SessionController } from '../interactive/controller.ts';
import type { ViewModel } from '../state/view-model.ts';
import { InputLine, PermissionDialog, StatusBar, TranscriptLine } from './parts.tsx';

/**
 * The Ink shell (step 13). Completed output goes through <Static> so only the
 * live tail re-renders — the rendering-cost mitigation from the plan's risk
 * register. All logic lives in SessionController + the reducer.
 */
export function App({ controller }: { controller: SessionController }): React.ReactElement {
  const [vm, setVm] = useState<ViewModel>(controller.state);
  const [input, setInput] = useState('');
  const [interruptArmed, setInterruptArmed] = useState(false);
  const { exit } = useApp();

  useEffect(() => controller.subscribe(setVm), [controller]);

  useInput((char, key) => {
    // Permission dialog takes over the keyboard while it is up.
    if (vm.pendingPermission !== null) {
      if (char === 'y') {
        controller.respondPermission('allow_once');
      } else if (char === 'a') {
        controller.respondPermission('allow_session');
      } else if (char === 'n' || key.escape) {
        controller.respondPermission('deny');
      }
      return;
    }

    if (key.ctrl && char === 'c') {
      if (controller.isWorking) {
        controller.interrupt();
        return;
      }
      if (interruptArmed || input === '') {
        exit();
        return;
      }
      setInput('');
      setInterruptArmed(true);
      return;
    }
    setInterruptArmed(false);

    if (key.escape && controller.isWorking) {
      controller.interrupt();
      return;
    }
    if (key.return) {
      if (input.trim().length > 0) {
        controller.submit(input);
        setInput('');
      }
      return;
    }
    if (key.delete || key.backspace) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && char !== '' && char >= ' ') {
      setInput((current) => current + char);
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={vm.transcript}>
        {(item) => <TranscriptLine key={item.id} item={item} />}
      </Static>

      {vm.liveThinking !== '' ? (
        <Box marginTop={1}>
          <Text dimColor italic>
            {vm.liveThinking}
          </Text>
        </Box>
      ) : null}
      {vm.liveText !== '' ? (
        <Box marginTop={1}>
          <Text>{vm.liveText}</Text>
        </Box>
      ) : null}

      {vm.activeTools.map((line) => (
        <Box key={line.callId}>
          <Text color="yellow">◐ </Text>
          <Text bold>{line.tool}</Text>
          <Text> {line.title}</Text>
        </Box>
      ))}

      {vm.pendingPermission !== null ? (
        <Box marginTop={1}>
          <PermissionDialog pending={vm.pendingPermission} />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <InputLine value={input} disabled={vm.pendingPermission !== null} />
        <StatusBar vm={vm} />
      </Box>
    </Box>
  );
}
