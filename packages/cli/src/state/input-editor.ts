/**
 * Pure input-editor state machine. Ink only forwards keypresses; every
 * behaviour (cursor motion, word delete, history recall, multiline) is decided
 * here so it can be unit-tested without a terminal.
 */
export interface InputState {
  value: string;
  /** Caret offset within `value`; always 0..value.length. */
  cursor: number;
  history: string[];
  /** null = editing a fresh line; otherwise an index into history. */
  historyIndex: number | null;
  /** The in-progress line stashed when history recall starts. */
  draft: string;
}

export interface KeyEvent {
  input: string;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type InputAction =
  | { type: 'none'; state: InputState }
  | { type: 'submit'; state: InputState; value: string };

export function initialInputState(history: string[] = []): InputState {
  return { value: '', cursor: 0, history, historyIndex: null, draft: '' };
}

const WORD_BOUNDARY = /\s/;

function previousWordStart(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && WORD_BOUNDARY.test(value[index - 1] ?? '')) {
    index -= 1;
  }
  while (index > 0 && !WORD_BOUNDARY.test(value[index - 1] ?? '')) {
    index -= 1;
  }
  return index;
}

function nextWordEnd(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && WORD_BOUNDARY.test(value[index] ?? '')) {
    index += 1;
  }
  while (index < value.length && !WORD_BOUNDARY.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}

function withValue(state: InputState, value: string, cursor: number): InputState {
  return { ...state, value, cursor: Math.max(0, Math.min(cursor, value.length)) };
}

export function reduceInput(state: InputState, key: KeyEvent): InputAction {
  const stay = (next: InputState): InputAction => ({ type: 'none', state: next });

  // Shift+Enter (and Ctrl/Alt+Enter) insert a newline instead of submitting.
  if (key.return === true) {
    if (key.shift === true || key.meta === true || key.ctrl === true) {
      const value = `${state.value.slice(0, state.cursor)}\n${state.value.slice(state.cursor)}`;
      return stay(withValue(state, value, state.cursor + 1));
    }
    const trimmed = state.value.trim();
    if (trimmed.length === 0) {
      return stay(state);
    }
    // Consecutive duplicates would just clutter recall.
    const history = state.history.at(-1) === trimmed ? state.history : [...state.history, trimmed];
    return {
      type: 'submit',
      value: trimmed,
      state: { value: '', cursor: 0, history, historyIndex: null, draft: '' }
    };
  }

  if (key.ctrl === true) {
    switch (key.input) {
      case 'a':
        return stay({ ...state, cursor: 0 });
      case 'e':
        return stay({ ...state, cursor: state.value.length });
      case 'u':
        return stay(withValue(state, state.value.slice(state.cursor), 0));
      case 'k':
        return stay(withValue(state, state.value.slice(0, state.cursor), state.cursor));
      case 'w': {
        const start = previousWordStart(state.value, state.cursor);
        return stay(
          withValue(state, state.value.slice(0, start) + state.value.slice(state.cursor), start)
        );
      }
      default:
        return stay(state);
    }
  }

  if (key.meta === true && (key.leftArrow === true || key.rightArrow === true)) {
    const cursor =
      key.leftArrow === true
        ? previousWordStart(state.value, state.cursor)
        : nextWordEnd(state.value, state.cursor);
    return stay({ ...state, cursor });
  }

  if (key.leftArrow === true) {
    return stay({ ...state, cursor: Math.max(0, state.cursor - 1) });
  }
  if (key.rightArrow === true) {
    return stay({ ...state, cursor: Math.min(state.value.length, state.cursor + 1) });
  }

  if (key.upArrow === true) {
    if (state.history.length === 0) {
      return stay(state);
    }
    const index =
      state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    const draft = state.historyIndex === null ? state.value : state.draft;
    const value = state.history[index] ?? '';
    return stay({ ...state, value, cursor: value.length, historyIndex: index, draft });
  }

  if (key.downArrow === true) {
    if (state.historyIndex === null) {
      return stay(state);
    }
    const next = state.historyIndex + 1;
    if (next >= state.history.length) {
      // Past the newest entry: restore what was being typed.
      return stay({ ...state, value: state.draft, cursor: state.draft.length, historyIndex: null });
    }
    const value = state.history[next] ?? '';
    return stay({ ...state, value, cursor: value.length, historyIndex: next });
  }

  if (key.backspace === true || key.delete === true) {
    if (state.cursor === 0) {
      return stay(state);
    }
    const value = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
    return stay(withValue(state, value, state.cursor - 1));
  }

  // Printable input (may be a multi-character paste).
  if (key.input !== '' && !key.meta) {
    const printable = [...key.input].filter((char) => char >= ' ' || char === '\n').join('');
    if (printable === '') {
      return stay(state);
    }
    const value = state.value.slice(0, state.cursor) + printable + state.value.slice(state.cursor);
    return stay(withValue(state, value, state.cursor + printable.length));
  }

  return stay(state);
}
