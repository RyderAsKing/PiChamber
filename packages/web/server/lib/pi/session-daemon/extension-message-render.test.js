import { describe, expect, it, vi } from 'vitest';

import {
  MAX_TOOL_RENDER_LINE_CHARS,
  MAX_TOOL_RENDER_LINES,
  TOOL_RENDER_WIDTH,
} from './extension-tool-render.js';
import { createExtensionMessageRenderer } from './extension-message-render.js';

const theme = { name: 'test-theme' };

const componentReturning = (lines, onWidth) => ({
  render: (width) => {
    onWidth?.(width);
    return lines;
  },
});

const sessionWith = (renderer, { throwOnLookup = false } = {}) => ({
  extensionRunner: {
    getMessageRenderer: (customType) => {
      if (throwOnLookup) throw new Error('lookup boom');
      if (customType !== 'my-type') return undefined;
      return renderer;
    },
  },
});

const message = (overrides = {}) => ({
  role: 'custom',
  customType: 'my-type',
  content: 'hello',
  display: true,
  details: { count: 1 },
  timestamp: 1700000000000,
  ...overrides,
});

describe('extension-message-render', () => {
  it('renders collapsed and expanded slots with Pi terminal arguments', () => {
    const seen = [];
    const widths = [];
    const renderer = createExtensionMessageRenderer({ theme });
    const fn = vi.fn((msg, options, th) => {
      seen.push([msg, options, th]);
      return componentReturning([`${options.expanded ? 'full' : 'short'} line`], (width) => widths.push(width));
    });
    const input = message();
    const render = renderer.renderMessage(sessionWith(fn), input);

    expect(render).toEqual({ message: ['short line'], messageExpanded: ['full line'] });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(seen[0][0]).toBe(input);
    expect(seen[0][1]).toEqual({ expanded: false, outputPad: 0 });
    expect(seen[0][2]).toBe(theme);
    expect(seen[1][1]).toEqual({ expanded: true, outputPad: 0 });
    expect(widths).toEqual([TOOL_RENDER_WIDTH, TOOL_RENDER_WIDTH]);
  });

  it('trims trailing spaces and bounds line count and length', () => {
    const renderer = createExtensionMessageRenderer({ theme });
    const longLine = `${'x'.repeat(MAX_TOOL_RENDER_LINE_CHARS + 500)}   `;
    const manyLines = Array.from({ length: MAX_TOOL_RENDER_LINES + 50 }, (_, index) => `line ${index}   `);
    const fn = (msg, options) => componentReturning(options.expanded ? manyLines : [longLine, 'padded   ']);
    const render = renderer.renderMessage(sessionWith(fn), message());

    expect(render.message).toHaveLength(2);
    expect(render.message[0]).toHaveLength(MAX_TOOL_RENDER_LINE_CHARS);
    expect(render.message[1]).toBe('padded');
    expect(render.messageExpanded).toHaveLength(MAX_TOOL_RENDER_LINES);
    expect(render.messageExpanded[0]).toBe('line 0');
  });

  it('redacts attachment paths in every rendered line', () => {
    const redactAttachmentPaths = (line) => String(line).replaceAll('/secret/path', '[attachment]');
    const renderer = createExtensionMessageRenderer({ theme, redactAttachmentPaths });
    const fn = (msg, options) => componentReturning([options.expanded ? 'see /secret/path full' : 'see /secret/path']);
    const render = renderer.renderMessage(sessionWith(fn), message());

    expect(render).toEqual({ message: ['see [attachment]'], messageExpanded: ['see [attachment] full'] });
  });

  it('omits render when the renderer throws, returns falsy, or yields no lines', () => {
    const renderer = createExtensionMessageRenderer({ theme });
    const input = message();
    expect(renderer.renderMessage(sessionWith(() => { throw new Error('render boom'); }), input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => undefined), input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => ({})), input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => componentReturning([])), input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => componentReturning('not-an-array')), input)).toBeUndefined();
  });

  it('omits render when no renderer is registered or lookup fails', () => {
    const renderer = createExtensionMessageRenderer({ theme });
    const input = message();
    expect(renderer.renderMessage(sessionWith(undefined), input)).toBeUndefined();
    expect(renderer.renderMessage({ extensionRunner: {} }, input)).toBeUndefined();
    expect(renderer.renderMessage({}, input)).toBeUndefined();
    expect(renderer.renderMessage(undefined, input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => componentReturning(['x']), { throwOnLookup: true }), input)).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => componentReturning(['x'])), message({ customType: 'other' }))).toBeUndefined();
    expect(renderer.renderMessage(sessionWith(() => componentReturning(['x'])), message({ customType: '' }))).toBeUndefined();
  });

  it('omits messageExpanded when expanded matches collapsed or fails', () => {
    const renderer = createExtensionMessageRenderer({ theme });
    const input = message();
    const same = (msg, options) => componentReturning(['same line']);
    expect(renderer.renderMessage(sessionWith(same), input)).toEqual({ message: ['same line'] });

    const expandedThrows = (msg, options) => {
      if (options.expanded) throw new Error('expanded boom');
      return componentReturning(['collapsed only']);
    };
    expect(renderer.renderMessage(sessionWith(expandedThrows), input)).toEqual({ message: ['collapsed only'] });

    const expandedEmpty = (msg, options) => (options.expanded ? componentReturning([]) : componentReturning(['collapsed only']));
    expect(renderer.renderMessage(sessionWith(expandedEmpty), input)).toEqual({ message: ['collapsed only'] });
  });

  it('rebuilds renderer input from a persisted entry and memoizes per entry', () => {
    const renderer = createExtensionMessageRenderer({ theme });
    const seen = [];
    const fn = vi.fn((msg) => {
      seen.push(msg);
      return componentReturning(['rendered']);
    });
    const session = sessionWith(fn);
    const timestamp = '2026-01-01T00:00:00.000Z';
    const entry = {
      type: 'custom_message',
      id: 'cm-1',
      customType: 'my-type',
      content: [{ type: 'text', text: 'inline note' }],
      display: true,
      details: { answer: 42 },
      timestamp,
    };

    const first = renderer.renderEntry(session, entry);
    expect(first).toEqual({ message: ['rendered'] });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      role: 'custom',
      customType: 'my-type',
      content: [{ type: 'text', text: 'inline note' }],
      display: true,
      details: { answer: 42 },
      timestamp: Date.parse(timestamp),
    });

    // Same entry object reuses the memoized render without calling the renderer again.
    expect(renderer.renderEntry(session, entry)).toBe(first);
    expect(fn).toHaveBeenCalledTimes(2);

    // A replaced session re-renders instead of reusing stale lines.
    const otherSession = sessionWith(fn);
    expect(renderer.renderEntry(otherSession, entry)).toEqual({ message: ['rendered'] });
    expect(fn).toHaveBeenCalledTimes(4);

    expect(renderer.renderEntry(session, undefined)).toBeUndefined();
    expect(renderer.renderEntry(session, null)).toBeUndefined();
  });
});
