import { afterEach, describe, expect, test } from 'bun:test';

import { copyMarkdownToClipboard, copyTextToClipboard } from './clipboard';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

const restoreGlobal = (name: 'navigator' | 'ClipboardItem', descriptor?: PropertyDescriptor): void => {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
};

afterEach(() => {
  restoreGlobal('navigator', originalNavigator);
  restoreGlobal('ClipboardItem', originalClipboardItem);
});

describe('copyTextToClipboard', () => {
  test('uses the plain-text clipboard API when available', async () => {
    let copiedText = '';
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
    });

    const result = await copyTextToClipboard('http://127.0.0.1:32145');

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(copiedText).toBe('http://127.0.0.1:32145');
  });

  test('reports failure when no clipboard mechanism is available', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

    const result = await copyTextToClipboard('http://127.0.0.1:32145');

    expect(result).toEqual({ ok: false, error: 'Clipboard access denied in current context' });
  });
});

describe('copyMarkdownToClipboard', () => {
  test('offers rich HTML and Markdown source in one clipboard item', async () => {
    let writtenItem: { data: Record<string, Blob> } | undefined;
    class FakeClipboardItem {
      static supports(type: string): boolean {
        return type === 'text/markdown';
      }

      readonly data: Record<string, Blob>;

      constructor(data: Record<string, Blob>) {
        this.data = data;
      }
    }

    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async (items: Array<{ data: Record<string, Blob> }>) => {
            writtenItem = items[0];
          },
        },
      },
    });

    const result = await copyMarkdownToClipboard('**bold**', '<p><strong>bold</strong></p>');

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(Object.keys(writtenItem?.data ?? {}).sort()).toEqual(['text/html', 'text/markdown', 'text/plain']);
    expect(await writtenItem?.data['text/plain']?.text()).toBe('**bold**');
    expect(await writtenItem?.data['text/markdown']?.text()).toBe('**bold**');
    expect(await writtenItem?.data['text/html']?.text()).toBe('<p><strong>bold</strong></p>');
  });

  test('falls back to plain Markdown when a rich clipboard write fails', async () => {
    let fallbackText = '';
    class FakeClipboardItem {
      static supports(): boolean {
        return false;
      }

      constructor() {}
    }

    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          write: async () => {
            throw new Error('unsupported');
          },
          writeText: async (text: string) => {
            fallbackText = text;
          },
        },
      },
    });

    const result = await copyMarkdownToClipboard('# title', '<h1>title</h1>');

    expect(result).toEqual({ ok: true, method: 'clipboard' });
    expect(fallbackText).toBe('# title');
  });
});
