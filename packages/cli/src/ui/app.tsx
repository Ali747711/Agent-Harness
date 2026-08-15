import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { SessionController } from '../interactive/controller.ts';
import { initialInputState, reduceInput } from '../state/input-editor.ts';
import { completions } from '../state/slash.ts';
import type { ViewModel } from '../state/view-model.ts';
import {
  Banner,
  InputLine,
  PermissionDialog,
  SlashMenu,
  StatusBar,
  ToolPanel,
  TranscriptLine
} from './parts.tsx';
import { theme } from './theme.ts';

/**
 * The Ink shell. Completed output goes through <Static> so only the live tail
 * re-renders (the rendering-cost mitigation from the plan's risk register);
 * the ticking clock is a single interval that runs ONLY while the agent is
 * working, so an idle session costs nothing.
 */
export function App({ controller }: { controller: SessionController }): React.ReactElement {
  const [vm, setVm] = useState<ViewModel>(controller.state);
  const [input, setInput] = useState(initialInputState());
  const [tick, setTick] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const { exit } = useApp();

  useEffect(() => controller.subscribe(setVm), [controller]);

  const busy = vm.status === 'working';
  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), theme.spinnerIntervalMs);
    return () => clearInterval(timer);
  }, [busy]);

  const menu = completions(input.value);
  const spinnerFrame = theme.spinner[tick % theme.spinner.length] ?? '';
  const now = Date.now();

  useInput((char, key) => {
    // The permission dialog owns the keyboard while it is up.
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
      if (interruptArmed || input.value === '') {
        exit();
        return;
      }
      setInput(initialInputState(input.history));
      setInterruptArmed(true);
      return;
    }
    setInterruptArmed(false);

    if (key.escape && controller.isWorking) {
      controller.interrupt();
      return;
    }

    // Tab completes the highlighted slash command.
    if (key.tab && menu.length > 0) {
      const chosen = menu[menuIndex % menu.length];
      if (chosen !== undefined) {
        const value = `/${chosen.name} `;
        setInput({ ...input, value, cursor: value.length });
        setMenuIndex(0);
      }
      return;
    }
    if (menu.length > 1 && (key.upArrow || key.downArrow)) {
      setMenuIndex((index) => (index + (key.downArrow ? 1 : menu.length - 1)) % menu.length);
      return;
    }

    const action = reduceInput(input, {
      input: char,
      backspace: key.backspace,
      delete: key.delete,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift
    });
    setInput(action.state);
    setMenuIndex(0);
    if (action.type === 'submit') {
      if (action.value === '/exit') {
        exit();
        return;
      }
      controller.submit(action.value);
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={vm.transcript}>
        {(item) => <TranscriptLine key={item.id} item={item} />}
      </Static>

      {vm.transcript.length === 0 ? <Banner vm={vm} /> : null}

      {vm.liveThinking !== '' ? (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor italic>
            {vm.liveThinking}
          </Text>
        </Box>
      ) : null}
      {vm.liveText !== '' ? (
        <Box marginTop={1} marginLeft={1}>
          <Text>{vm.liveText}</Text>
        </Box>
      ) : null}

      {vm.activeTools.map((line) => (
        <ToolPanel key={line.callId} line={line} now={now} />
      ))}

      {vm.pendingPermission !== null ? <PermissionDialog pending={vm.pendingPermission} /> : null}

      <Box marginTop={1} flexDirection="column">
        {menu.length > 0 ? <SlashMenu commands={menu} selected={menuIndex % menu.length} /> : null}
        <InputLine
          value={input.value}
          cursor={input.cursor}
          disabled={vm.pendingPermission !== null}
        />
        <StatusBar vm={vm} spinnerFrame={busy ? spinnerFrame : undefined} now={now} />
      </Box>
    </Box>
  );
}
