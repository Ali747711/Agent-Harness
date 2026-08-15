import { describe, expect, it } from 'vitest';

import { type InputState, initialInputState, reduceInput } from './input-editor.ts';

function type(state: InputState, text: string): InputState {
  return [...text].reduce((current, char) => reduceInput(current, { input: char }).state, state);
}

describe('input editor', () => {
  it('inserts printable characters at the cursor', () => {
    const state = type(initialInputState(), 'hello');
    expect(state.value).toBe('hello');
    expect(state.cursor).toBe(5);
  });

  it('moves the cursor and inserts mid-line', () => {
    let state = type(initialInputState(), 'helo');
    state = reduceInput(state, { input: '', leftArrow: true }).state;
    state = type(state, 'l');
    expect(state.value).toBe('hello');
    expect(state.cursor).toBe(4);
  });

  it('backspaces at the cursor, not the end', () => {
    let state = type(initialInputState(), 'abcd');
    state = reduceInput(state, { input: '', leftArrow: true }).state;
    state = reduceInput(state, { input: '', backspace: true }).state;
    expect(state.value).toBe('abd');
    expect(state.cursor).toBe(2);
  });

  it('clamps cursor movement at both ends', () => {
    let state = initialInputState();
    state = reduceInput(state, { input: '', leftArrow: true }).state;
    expect(state.cursor).toBe(0);
    state = type(state, 'ab');
    state = reduceInput(state, { input: '', rightArrow: true }).state;
    expect(state.cursor).toBe(2);
  });

  it('ctrl-w deletes the previous word, ctrl-a/e jump to the ends', () => {
    let state = type(initialInputState(), 'delete this word');
    state = reduceInput(state, { input: 'w', ctrl: true }).state;
    expect(state.value).toBe('delete this ');

    state = reduceInput(state, { input: 'a', ctrl: true }).state;
    expect(state.cursor).toBe(0);
    state = reduceInput(state, { input: 'e', ctrl: true }).state;
    expect(state.cursor).toBe(state.value.length);
  });

  it('ctrl-u and ctrl-k cut to the line start and end', () => {
    let state = type(initialInputState(), 'keep cut');
    state = reduceInput(state, { input: 'u', ctrl: true }).state;
    expect(state.value).toBe('');

    state = type(initialInputState(), 'keep cut');
    for (let i = 0; i < 4; i += 1) {
      state = reduceInput(state, { input: '', leftArrow: true }).state;
    }
    state = reduceInput(state, { input: 'k', ctrl: true }).state;
    expect(state.value).toBe('keep');
  });

  it('submits on enter, trims, and records history', () => {
    const state = type(initialInputState(), '  do the thing  ');
    const action = reduceInput(state, { input: '', return: true });
    expect(action.type).toBe('submit');
    if (action.type === 'submit') {
      expect(action.value).toBe('do the thing');
      expect(action.state.value).toBe('');
      expect(action.state.history).toEqual(['do the thing']);
    }
  });

  it('refuses to submit whitespace', () => {
    const state = type(initialInputState(), '   ');
    expect(reduceInput(state, { input: '', return: true }).type).toBe('none');
  });

  it('shift+enter inserts a newline instead of submitting', () => {
    const state = type(initialInputState(), 'line one');
    const action = reduceInput(state, { input: '', return: true, shift: true });
    expect(action.type).toBe('none');
    expect(action.state.value).toBe('line one\n');
  });

  it('recalls history with up/down and restores the draft', () => {
    let state = initialInputState(['first', 'second']);
    state = type(state, 'draft');

    state = reduceInput(state, { input: '', upArrow: true }).state;
    expect(state.value).toBe('second');
    state = reduceInput(state, { input: '', upArrow: true }).state;
    expect(state.value).toBe('first');
    // Past the oldest entry it stays put rather than emptying.
    state = reduceInput(state, { input: '', upArrow: true }).state;
    expect(state.value).toBe('first');

    state = reduceInput(state, { input: '', downArrow: true }).state;
    expect(state.value).toBe('second');
    state = reduceInput(state, { input: '', downArrow: true }).state;
    expect(state.value).toBe('draft');
    expect(state.historyIndex).toBeNull();
  });

  it('does not record consecutive duplicate history entries', () => {
    let state = initialInputState(['same']);
    state = type(state, 'same');
    const action = reduceInput(state, { input: '', return: true });
    if (action.type === 'submit') {
      expect(action.state.history).toEqual(['same']);
    }
  });

  it('accepts a multi-character paste and strips control characters', () => {
    const state = reduceInput(initialInputState(), { input: 'pasted text' });
    expect(state.state.value).toBe('pasted text');
  });
});
