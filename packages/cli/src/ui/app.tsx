import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';

import type { SessionController } from '../interactive/controller.ts';
import { initialInputState, reduceInput } from '../state/input-editor.ts';
import { completions } from '../state/slash.ts';
import type { TranscriptItem, ViewModel } from '../state/view-model.ts';
import {
  EmptyState,
  Footer,
  Header,
  InputBox,
  Markdown,
  PermissionDialog,
  SlashMenu,
  ToolRow,
  TranscriptLine
} from './parts.tsx';
import { theme } from './theme.ts';

/**
 * Layout: header · transcript (grows) · input · footer.
 *
 * Completed output goes through <Static> so only the live tail re-renders (the
 * rendering-cost mitigation from the plan's risk register), and the clock
 * interval runs ONLY while the agent is working, so an idle session is free.
 */
const PLACEHOLDER = 'Ask anything, or /help';

export function App({
  controller,
  version = '0.0.1'
}: {
  controller: SessionController;
  version?: string;
}): React.ReactElement {
  const [vm, setVm] = useState<ViewModel>(controller.state);
  const [input, setInput] = useState(initialInputState());
  const [tick, setTick] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = Math.max(40, stdout?.columns ?? 80);

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
    // The permission prompt owns the keyboard while it is up.
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

    // shift+tab cycles the permission mode, so the footer is live state.
    if (key.tab && key.shift) {
      controller.cyclePermissionMode();
      return;
    }

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

  // The header joins the static stream as item 0. Ink flushes <Static> output
  // permanently ABOVE the live region, so a header rendered dynamically would
  // end up printed below the transcript on every frame.
  const staticItems: Array<{ id: string } & ({ header: true } | { item: TranscriptItem })> = [
    { id: '__header', header: true },
    ...vm.transcript.map((item) => ({ id: item.id, item }))
  ];

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(entry) =>
          'header' in entry ? (
            <Header key={entry.id} vm={vm} version={version} columns={columns} />
          ) : (
            <TranscriptLine key={entry.id} item={entry.item} columns={columns} />
          )
        }
      </Static>

      {vm.transcript.length === 0 ? <EmptyState /> : null}

      {vm.liveThinking !== '' ? (
        <Box marginTop={1}>
          <Text dimColor italic>
            {vm.liveThinking}
          </Text>
        </Box>
      ) : null}
      {vm.liveText !== '' ? (
        <Box marginTop={1}>
          <Markdown source={vm.liveText} />
        </Box>
      ) : null}

      {vm.activeTools.map((line) => (
        <Box key={line.callId} marginTop={1}>
          <ToolRow line={line} now={now} columns={columns} />
        </Box>
      ))}

      {vm.pendingPermission !== null ? <PermissionDialog pending={vm.pendingPermission} /> : null}

      {/* input + footer */}
      <Box marginTop={1} flexDirection="column">
        {menu.length > 0 ? <SlashMenu commands={menu} selected={menuIndex % menu.length} /> : null}
        <InputBox
          value={input.value}
          cursor={input.cursor}
          disabled={vm.pendingPermission !== null}
          placeholder={PLACEHOLDER}
          busy={busy}
        />
        <Footer
          vm={vm}
          spinnerFrame={busy ? spinnerFrame : undefined}
          now={now}
          columns={columns}
        />
      </Box>
    </Box>
  );
}
