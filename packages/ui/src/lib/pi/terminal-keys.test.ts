import { describe, expect, test as it } from 'bun:test';

import { bracketedPaste, encodeMouseReport, encodeTerminalKey, textEditInput } from './terminal-keys';

const key = (value: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  encodeTerminalKey({ key: value, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe('encodeTerminalKey', () => {
  it('sends printable text and editing keys as a terminal would', () => {
    expect(key('a')).toBe('a');
    expect(key('A', { shiftKey: true })).toBe('A');
    expect(key('é')).toBe('é');
    expect(key('😀')).toBe('😀');
    expect(key('Enter')).toBe('\r');
    expect(key('Escape')).toBe('\x1b');
    expect(key('Tab')).toBe('\t');
    expect(key('Tab', { shiftKey: true })).toBe('\x1b[Z');
    expect(key('Backspace')).toBe('\x7f');
  });

  it('adds the xterm modifier parameter to cursor keys', () => {
    expect(key('ArrowUp')).toBe('\x1b[A');
    expect(key('ArrowLeft', { ctrlKey: true })).toBe('\x1b[1;5D');
    expect(key('End', { shiftKey: true })).toBe('\x1b[1;2F');
    expect(key('Delete')).toBe('\x1b[3~');
    expect(key('PageDown', { altKey: true })).toBe('\x1b[6;3~');
  });

  it('maps control and alt chords', () => {
    expect(key('c', { ctrlKey: true })).toBe('\x03');
    expect(key('C', { ctrlKey: true, shiftKey: true })).toBe('\x03');
    expect(key('x', { ctrlKey: true, altKey: true })).toBe('\x1b\x18');
    expect(key('b', { altKey: true })).toBe('\x1bb');
    expect(key(' ', { ctrlKey: true })).toBe('\x00');
  });

  it('sends Enter with Shift or Ctrl as CSI-u, which pi-tui reads as shift+enter and ctrl+enter', () => {
    expect(key('Enter', { shiftKey: true })).toBe('\x1b[13;2u');
    expect(key('Enter', { ctrlKey: true })).toBe('\x1b[13;5u');
    expect(key('Enter', { ctrlKey: true, shiftKey: true })).toBe('\x1b[13;6u');
    expect(key('Enter', { altKey: true })).toBe('\x1b\r');
  });

  it('types AltGr characters instead of encoding them as Ctrl+Alt chords', () => {
    // Windows reports AltGr as Ctrl+Alt (German layout: AltGr+8 is `[`, AltGr+Q is `@`).
    expect(key('[', { ctrlKey: true, altKey: true })).toBe('[');
    expect(key('@', { ctrlKey: true, altKey: true })).toBe('@');
    expect(key('{', { ctrlKey: true, altKey: true })).toBe('{');
    expect(key('€', { ctrlKey: true, altKey: true })).toBe('€');
    const altGraph = encodeTerminalKey({
      key: '|', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false,
      getModifierState: (name) => name === 'AltGraph',
    });
    expect(altGraph).toBe('|');
    // A real Ctrl+Alt letter chord is still a control chord.
    expect(key('x', { ctrlKey: true, altKey: true })).toBe('\x1b\x18');
  });

  it('leaves meta chords and unknown keys to the browser', () => {
    expect(key('c', { metaKey: true })).toBeNull();
    expect(key('F5')).toBeNull();
    expect(key('Shift', { shiftKey: true })).toBeNull();
    expect(key('1', { ctrlKey: true })).toBeNull();
  });
});

describe('bracketedPaste', () => {
  it('wraps text and strips embedded paste markers', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
    expect(bracketedPaste('x\x1b[201~y')).toBe('\x1b[200~xy\x1b[201~');
  });
});

describe('encodeMouseReport', () => {
  const report = (action: Parameters<typeof encodeMouseReport>[0]['action'], extra: Partial<Parameters<typeof encodeMouseReport>[0]> = {}) =>
    encodeMouseReport({ action, button: 0, col: 2, row: 1, shiftKey: false, altKey: false, ctrlKey: false, ...extra });

  it('sends SGR reports with one-based cells', () => {
    expect(report('press')).toBe('\x1b[<0;3;2M');
    expect(report('release')).toBe('\x1b[<0;3;2m');
    expect(report('drag')).toBe('\x1b[<32;3;2M');
    expect(report('press', { button: 2 })).toBe('\x1b[<2;3;2M');
  });

  it('codes the wheel and modifiers', () => {
    expect(report('wheel-up')).toBe('\x1b[<64;3;2M');
    expect(report('wheel-down', { button: 2 })).toBe('\x1b[<65;3;2M');
    expect(report('press', { shiftKey: true, altKey: true, ctrlKey: true })).toBe('\x1b[<28;3;2M');
  });

  it('clamps positions to the surface origin', () => {
    expect(report('press', { col: -3, row: -0.5 })).toBe('\x1b[<0;1;1M');
    expect(report('press', { col: 4.9, row: 0.2 })).toBe('\x1b[<0;5;1M');
  });
});

describe('textEditInput', () => {
  it('sends new text, and Backspaces for text taken back', () => {
    expect(textEditInput('', 'he')).toBe('he');
    expect(textEditInput('he', 'hel')).toBe('l');
    expect(textEditInput('teh', 'the')).toBe('\x7f\x7fhe');
    expect(textEditInput('word', '')).toBe('\x7f\x7f\x7f\x7f');
    expect(textEditInput('same', 'same')).toBe('');
  });

  it('counts characters, not UTF-16 units, and sends newlines as Enter', () => {
    expect(textEditInput('a😀', 'a')).toBe('\x7f');
    expect(textEditInput('', 'one\ntwo')).toBe('one\rtwo');
  });
});
