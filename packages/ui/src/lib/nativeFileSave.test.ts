import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let mockPlatform: 'android' | 'ios' | 'web' | 'desktop' = 'web';
const shareCalls: Array<{ filename: string; mimeType?: string; base64: string }> = [];
const setWebViewBackgroundCalls: Array<{ color: string }> = [];

mock.module('@/lib/platform', () => ({
  getClientPlatform: () => mockPlatform,
  isCapacitorApp: () => mockPlatform === 'android' || mockPlatform === 'ios',
}));

mock.module('@capacitor/core', () => ({
  registerPlugin: () => ({
    share: async (options: { filename: string; mimeType?: string; base64: string }) => {
      shareCalls.push(options);
      return { status: 'shared' };
    },
    setWebViewBackground: async (options: { color: string }) => {
      setWebViewBackgroundCalls.push(options);
    },
  }),
}));

describe('nativeFileSave', () => {
  let createdAnchors: Array<{
    href: string;
    download: string;
    clicked: boolean;
    appended: boolean;
    removed: boolean;
  }> = [];

  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;
  const originalURL = globalThis.URL;

  beforeEach(() => {
    mockPlatform = 'web';
    shareCalls.length = 0;
    setWebViewBackgroundCalls.length = 0;
    createdAnchors = [];

    // Mock document and anchor creation
    const doc = {
      createElement: (tag: string) => {
        if (tag === 'a') {
          const anchor = {
            href: '',
            download: '',
            clicked: false,
            appended: false,
            removed: false,
            click() {
              this.clicked = true;
            },
          };
          createdAnchors.push(anchor);
          return anchor;
        }
        return {};
      },
      body: {
        appendChild: (el: { appended?: boolean }) => {
          el.appended = true;
          return el;
        },
        removeChild: (el: { removed?: boolean }) => {
          el.removed = true;
          return el;
        },
      },
    };

    (globalThis as Record<string, unknown>).document = doc;
    (globalThis as Record<string, unknown>).URL = {
      createObjectURL: (blob: Blob) => `blob:mock-url-${blob.size}`,
      revokeObjectURL: () => {},
    };
  });

  afterEach(() => {
    if (originalDocument) {
      (globalThis as Record<string, unknown>).document = originalDocument;
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (originalNavigator) {
      (globalThis as Record<string, unknown>).navigator = originalNavigator;
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
    if (originalURL) {
      (globalThis as Record<string, unknown>).URL = originalURL;
    } else {
      Reflect.deleteProperty(globalThis, 'URL');
    }
  });

  test('web path triggers anchor download and never touches native plugin', async () => {
    mockPlatform = 'web';
    const { saveOrShareFile } = await import('./nativeFileSave');

    const result = await saveOrShareFile({
      filename: 'export.md',
      mimeType: 'text/markdown',
      data: '# Header\nHello world',
    });

    expect(result).toBe('downloaded');
    expect(shareCalls.length).toBe(0);
    expect(createdAnchors.length).toBe(1);
    expect(createdAnchors[0].download).toBe('export.md');
    expect(createdAnchors[0].href).toContain('blob:mock-url-');
    expect(createdAnchors[0].clicked).toBe(true);
    expect(createdAnchors[0].appended).toBe(true);
    expect(createdAnchors[0].removed).toBe(true);
  });

  test('web path supports direct data URL strings', async () => {
    mockPlatform = 'web';
    const { saveOrShareFile } = await import('./nativeFileSave');

    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveOrShareFile({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      data: dataUrl,
    });

    expect(result).toBe('downloaded');
    expect(shareCalls.length).toBe(0);
    expect(createdAnchors.length).toBe(1);
    expect(createdAnchors[0].download).toBe('screenshot.png');
    expect(createdAnchors[0].href).toBe(dataUrl);
    expect(createdAnchors[0].clicked).toBe(true);
  });

  test('android path calls PiChamberFiles plugin with base64 data', async () => {
    mockPlatform = 'android';
    const { saveOrShareFile } = await import('./nativeFileSave');

    const result = await saveOrShareFile({
      filename: 'test.md',
      mimeType: 'text/markdown',
      data: '# Android export',
    });

    expect(result).toBe('shared');
    expect(shareCalls.length).toBe(1);
    const callArg = shareCalls[0];
    expect(callArg.filename).toBe('test.md');
    expect(callArg.mimeType).toBe('text/markdown');
    expect(typeof callArg.base64).toBe('string');
    expect(callArg.base64.length).toBeGreaterThan(0);
    expect(createdAnchors.length).toBe(0);
  });

  test('android path extracts base64 from data URLs', async () => {
    mockPlatform = 'android';
    const { saveOrShareFile } = await import('./nativeFileSave');

    const base64Content = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${base64Content}`;

    const result = await saveOrShareFile({
      filename: 'image.png',
      mimeType: 'image/png',
      data: dataUrl,
    });

    expect(result).toBe('shared');
    expect(shareCalls.length).toBe(1);
    const callArg = shareCalls[0];
    expect(callArg.filename).toBe('image.png');
    expect(callArg.base64).toBe(base64Content);
  });

  test('iOS path uses navigator.share with File when canShare returns true', async () => {
    mockPlatform = 'ios';
    const sharedFiles: File[] = [];
    const navShareCalls: Array<{ files?: File[] }> = [];

    (globalThis as Record<string, unknown>).navigator = {
      canShare: (options?: { files?: File[] }) => Boolean(options?.files?.length),
      share: async (options: { files?: File[] }) => {
        navShareCalls.push(options);
        if (options.files) sharedFiles.push(...options.files);
      },
    };

    const { saveOrShareFile } = await import('./nativeFileSave');

    const result = await saveOrShareFile({
      filename: 'session.md',
      mimeType: 'text/markdown',
      data: '# iOS export',
    });

    expect(result).toBe('shared');
    expect(navShareCalls.length).toBe(1);
    expect(sharedFiles.length).toBe(1);
    expect(sharedFiles[0].name).toBe('session.md');
    expect(sharedFiles[0].type).toBe('text/markdown');
    expect(shareCalls.length).toBe(0);
    expect(createdAnchors.length).toBe(0);
  });

  test('iOS path treats AbortError as cancelled', async () => {
    mockPlatform = 'ios';
    let navShareInvoked = 0;

    (globalThis as Record<string, unknown>).navigator = {
      canShare: () => true,
      share: async () => {
        navShareInvoked += 1;
        const error = new Error('Share canceled by user');
        error.name = 'AbortError';
        throw error;
      },
    };

    const { saveOrShareFile } = await import('./nativeFileSave');

    const result = await saveOrShareFile({
      filename: 'cancelled.md',
      mimeType: 'text/markdown',
      data: '# Content',
    });

    expect(result).toBe('cancelled');
    expect(navShareInvoked).toBe(1);
  });

  test('iOS path falls back to anchor download if canShare returns false', async () => {
    mockPlatform = 'ios';
    (globalThis as Record<string, unknown>).navigator = {
      canShare: () => false,
      share: async () => {},
    };

    const { saveOrShareFile } = await import('./nativeFileSave');

    const result = await saveOrShareFile({
      filename: 'fallback.md',
      mimeType: 'text/markdown',
      data: '# Fallback',
    });

    expect(result).toBe('downloaded');
    expect(createdAnchors.length).toBe(1);
    expect(createdAnchors[0].download).toBe('fallback.md');
  });

  test('setNativeWebViewBackground calls plugin on android', async () => {
    mockPlatform = 'android';
    const { setNativeWebViewBackground } = await import('./nativeFileSave');

    await setNativeWebViewBackground('#171515');
    expect(setWebViewBackgroundCalls.length).toBe(1);
    expect(setWebViewBackgroundCalls[0].color).toBe('#171515');
  });

  test('setNativeWebViewBackground is a no-op on non-android platforms', async () => {
    mockPlatform = 'web';
    const { setNativeWebViewBackground } = await import('./nativeFileSave');

    await setNativeWebViewBackground('#171515');
    expect(setWebViewBackgroundCalls.length).toBe(0);
  });

  test('isShareCancelledError identifies abort and cancel errors', async () => {
    const { isShareCancelledError } = await import('./nativeFileSave');

    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    expect(isShareCancelledError(abortError)).toBe(true);

    const messageAbortError = new Error('AbortError: user canceled');
    expect(isShareCancelledError(messageAbortError)).toBe(true);

    const cancelError = new Error('User cancelled share sheet');
    expect(isShareCancelledError(cancelError)).toBe(true);

    expect(isShareCancelledError(new Error('Permission denied'))).toBe(false);
    expect(isShareCancelledError('AbortError')).toBe(false);
    expect(isShareCancelledError(null)).toBe(false);
    expect(isShareCancelledError(undefined)).toBe(false);
  });
});
