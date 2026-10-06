import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

// The hook only uses `toast` from the UI barrel; replace it so the test stays
// self-contained and records error surfacing.
const toastErrors: string[] = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => undefined,
  },
}));

const {
  useComposerPaste,
  isOversizedPastedText,
  createOversizedPastedTextFile,
  OVERSIZED_PASTE_TEXT_THRESHOLD,
  OVERSIZED_PASTE_FILENAME,
} = await import('../useComposerPaste');
import type { UseComposerPasteOptions } from '../useComposerPaste';
import type { ComposerEditorHandle } from '../../editor/ComposerEditor';

type PasteHandler = (event: ClipboardEvent) => Promise<void>;

let latestHandler: PasteHandler | null = null;
const Probe = (props: UseComposerPasteOptions) => {
  latestHandler = useComposerPaste(props);
  return null;
};

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const roots: Root[] = [];
const restoreFns: Array<() => void> = [];

const renderPasteHook = async (props: UseComposerPasteOptions) => {
  const dom = installMinimalDom();
  restoreFns.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Probe, props));
  });
  if (!latestHandler) throw new Error('paste handler was not captured');
  return latestHandler;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreFns.splice(0).forEach((restore) => restore());
  latestHandler = null;
  toastErrors.length = 0;
});

const imageFile = (name = 'shot.png') => new File(['img-bytes'], name, { type: 'image/png' });

interface FakeClipboardOptions {
  text?: string;
  files?: File[];
  items?: Array<{ kind: string; type?: string; file?: File | null }>;
}

const fakeClipboardEvent = (options: FakeClipboardOptions = {}) => {
  const text = options.text ?? '';
  const files = options.files ?? [];
  const items = (options.items ?? []).map((item) => ({
    kind: item.kind,
    type: item.type ?? '',
    getAsFile: () => item.file ?? null,
  }));
  let prevented = false;
  const event = {
    clipboardData: {
      files,
      items,
      getData: () => text,
    },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as ClipboardEvent;
  return {
    event,
    wasPrevented: () => prevented,
  };
};

interface Harness {
  handler: PasteHandler;
  calls: {
    inserted: string[];
    setMessages: string[];
    autocompleteUpdates: number;
    mentionSuppressions: number;
    attached: File[];
  };
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  addAttachedFileImpl: (file: File) => Promise<boolean>;
  setAddAttachedFileImpl: (impl: (file: File) => Promise<boolean>) => void;
}

const setup = async (overrides: Partial<UseComposerPasteOptions> = {}): Promise<Harness> => {
  const calls = {
    inserted: [] as string[],
    setMessages: [] as string[],
    autocompleteUpdates: 0,
    mentionSuppressions: 0,
    attached: [] as File[],
  };
  let impl: (file: File) => Promise<boolean> = async (file: File) => {
    calls.attached.push(file);
    return true;
  };
  const composerRef = {
    current: {
      getSelection: () => ({ start: 0, end: 0 }),
      setSelection: () => undefined,
    } as unknown as ComposerEditorHandle,
  };
  const handler = await renderPasteHook({
    inputMode: 'normal',
    enabled: true,
    composerRef: composerRef as React.RefObject<ComposerEditorHandle | null>,
    message: 'draft',
    setMessage: (next: string) => {
      calls.setMessages.push(next);
    },
    insertTextAtSelection: (text: string) => {
      calls.inserted.push(text);
    },
    updateAutocompleteState: () => {
      calls.autocompleteUpdates += 1;
    },
    markFileMentionPasteSuppression: () => {
      calls.mentionSuppressions += 1;
    },
    attachedFiles: [],
    addAttachedFile: (file: File) => impl(file),
    ...overrides,
  });
  return {
    handler,
    calls,
    composerRef: composerRef as React.RefObject<ComposerEditorHandle | null>,
    addAttachedFileImpl: (file: File) => impl(file),
    setAddAttachedFileImpl: (next) => {
      impl = next;
    },
  };
};

describe('oversized paste threshold', () => {
  test('threshold is the documented 16,000 UTF-16 code units', () => {
    expect(OVERSIZED_PASTE_TEXT_THRESHOLD).toBe(16_000);
    expect(OVERSIZED_PASTE_FILENAME).toBe('pasted-text.txt');
  });

  test('below threshold keeps native semantics', async () => {
    const h = await setup();
    const text = `hello @user ${'x'.repeat(100)}`;
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(false);
    expect(h.calls.attached).toHaveLength(0);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.setMessages).toHaveLength(0);
    // Small @-paste still suppresses the mention picker.
    expect(h.calls.mentionSuppressions).toBe(1);
    expect(toastErrors).toEqual([]);
  });

  test('exactly at threshold keeps native semantics', async () => {
    const h = await setup();
    const text = 'a'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD);
    expect(isOversizedPastedText(text)).toBe(false);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(false);
    expect(h.calls.attached).toHaveLength(0);
    expect(h.calls.inserted).toHaveLength(0);
  });

  test('one over threshold becomes one .txt attachment with zero inline insertion', async () => {
    const h = await setup();
    const text = 'b'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 1);
    expect(isOversizedPastedText(text)).toBe(true);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    expect(h.calls.attached).toHaveLength(1);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.setMessages).toHaveLength(0);
    expect(h.calls.autocompleteUpdates).toBe(0);
    const file = h.calls.attached[0];
    expect(file.name).toBe('pasted-text.txt');
    expect(file.type.split(';')[0]).toBe('text/plain');
    expect(await file.text()).toBe(text);
    expect(toastErrors).toEqual([]);
  });

  test('preventDefault runs synchronously for oversized paste', async () => {
    const h = await setup();
    let resolveAttach!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      resolveAttach = resolve;
    });
    h.setAddAttachedFileImpl((file: File) => {
      h.calls.attached.push(file);
      return gate;
    });
    const text = 'c'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 10);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    const pending = h.handler(event);
    // The async handler runs synchronously until its first await, so the
    // native paste is already canceled before the upload settles.
    expect(wasPrevented()).toBe(true);
    resolveAttach(true);
    await pending;
    expect(h.calls.attached).toHaveLength(1);
  });
});

describe('oversized paste fidelity', () => {
  test('full Unicode and newlines survive the .txt round trip', async () => {
    const h = await setup();
    const unit = 'line 🌊\t tab\nline2 @mention #tag /cmd\r\nend 𝄞\u0000? ';
    const repeats = Math.ceil((OVERSIZED_PASTE_TEXT_THRESHOLD + 100) / unit.length);
    const text = unit.repeat(repeats);
    expect(text.length).toBeGreaterThan(OVERSIZED_PASTE_TEXT_THRESHOLD);
    const { event } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(h.calls.attached).toHaveLength(1);
    expect(await h.calls.attached[0].text()).toBe(text);
    expect(h.calls.inserted).toHaveLength(0);
  });

  test('large multi-MB paste enqueues once with no editor insertion', async () => {
    const h = await setup();
    const text = `${'lorem ipsum dolor sit amet\n'.repeat(80_000)}🌊 end`;
    expect(text.length).toBeGreaterThan(2_000_000);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    // Operation-count contract: one attachment enqueue, zero editor writes.
    expect(h.calls.attached).toHaveLength(1);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.setMessages).toHaveLength(0);
    expect(h.calls.autocompleteUpdates).toBe(0);
    expect(await h.calls.attached[0].text()).toBe(text);
  });

  test('pure helper preserves exact text without editor involvement', async () => {
    const text = `exact 🌊\ntext @here ${'z'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD)}`;
    const file = createOversizedPastedTextFile(text);
    expect(file.name).toBe('pasted-text.txt');
    expect(file.type.split(';')[0]).toBe('text/plain');
    expect(await file.text()).toBe(text);
  });
});

describe('existing paste semantics', () => {
  test('URL over selection still wraps as a markdown link', async () => {
    const inserted: string[] = [];
    let setSelections = 0;
    const composerRef = {
      current: {
        getSelection: () => ({ start: 0, end: 4 }),
        setSelection: () => {
          setSelections += 1;
        },
      } as unknown as ComposerEditorHandle,
    };
    const handler = await renderPasteHook({
      inputMode: 'normal',
      enabled: true,
      composerRef: composerRef as React.RefObject<ComposerEditorHandle | null>,
      message: 'docs rest',
      setMessage: () => {},
      insertTextAtSelection: (text: string) => {
        inserted.push(text);
      },
      updateAutocompleteState: () => {},
      markFileMentionPasteSuppression: () => {},
      attachedFiles: [],
      addAttachedFile: async () => true,
    });
    const { event, wasPrevented } = fakeClipboardEvent({ text: 'https://x.dev' });
    await handler(event);
    expect(wasPrevented()).toBe(true);
    // Small URLs keep link wrapping; oversized text never wraps (see below).
    expect(setSelections).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  test('oversized URL over selection becomes .txt attachment instead of markdown link', async () => {
    let setSelections = 0;
    const composerRef = {
      current: {
        getSelection: () => ({ start: 0, end: 4 }),
        setSelection: () => {
          setSelections += 1;
        },
      } as unknown as ComposerEditorHandle,
    };
    const h = await setup({
      message: 'docs rest',
      composerRef: composerRef as React.RefObject<ComposerEditorHandle | null>,
    });
    const bigUrl = `https://x.dev/${'a'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD)}`;
    expect(bigUrl.length).toBeGreaterThan(OVERSIZED_PASTE_TEXT_THRESHOLD);
    const { event, wasPrevented } = fakeClipboardEvent({ text: bigUrl });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    expect(h.calls.attached).toHaveLength(1);
    expect(await h.calls.attached[0].text()).toBe(bigUrl);
    expect(h.calls.attached[0].name).toBe('pasted-text.txt');
    expect(h.calls.setMessages).toHaveLength(0);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.autocompleteUpdates).toBe(0);
    expect(setSelections).toBe(0);
    expect(toastErrors).toEqual([]);
  });

  test('image paste keeps citation insertion and per-image enqueue', async () => {
    const h = await setup();
    const { event, wasPrevented } = fakeClipboardEvent({
      text: 'look',
      files: [imageFile()],
    });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    expect(h.calls.inserted).toHaveLength(1);
    expect(h.calls.inserted[0]).toContain('look');
    expect(h.calls.inserted[0]).toContain('.png');
    expect(h.calls.attached).toHaveLength(1);
    expect(h.calls.attached[0].type).toBe('image/png');
  });

  test('mixed image plus oversized text attaches .txt and inserts citation only', async () => {
    const h = await setup();
    const big = `mixed ${'y'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 50)}`;
    const { event, wasPrevented } = fakeClipboardEvent({
      text: big,
      files: [imageFile('photo.png')],
    });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    // One text enqueue plus one image enqueue, but no huge inline text.
    expect(h.calls.attached).toHaveLength(2);
    const textFile = h.calls.attached.find((file) => file.name === 'pasted-text.txt');
    expect(textFile?.type.split(';')[0]).toBe('text/plain');
    expect(await textFile!.text()).toBe(big);
    expect(h.calls.inserted).toHaveLength(1);
    expect(h.calls.inserted[0]).not.toContain(big.slice(0, 100));
    expect(h.calls.inserted[0]).toContain('.png');
  });

  test('disabled composer preserves read-only behavior for oversized text', async () => {
    const h = await setup({ enabled: false });
    const text = 'd'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 5);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(false);
    expect(h.calls.attached).toHaveLength(0);
    expect(h.calls.inserted).toHaveLength(0);
  });
});

describe('oversized paste failures and limits', () => {
  test('rejected enqueue stays visible with no silent fallback insertion', async () => {
    const h = await setup();
    h.setAddAttachedFileImpl(async (file: File) => {
      h.calls.attached.push(file);
      return false;
    });
    const text = 'e'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 5);
    const { event, wasPrevented } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(wasPrevented()).toBe(true);
    expect(h.calls.attached).toHaveLength(1);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.setMessages).toHaveLength(0);
    expect(toastErrors).toEqual(['Failed to attach pasted text as file']);
  });

  test('thrown enqueue stays visible with no silent fallback insertion', async () => {
    const h = await setup();
    h.setAddAttachedFileImpl(async () => {
      throw new Error('You can attach up to 20 files to one message.');
    });
    const text = 'f'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 5);
    const { event } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(h.calls.inserted).toHaveLength(0);
    expect(h.calls.setMessages).toHaveLength(0);
    // Thrown text-enqueue errors stay visible through a fixed safe toast;
    // the thrown detail is not logged or surfaced because it may be user-sensitive.
    expect(toastErrors).toEqual(['Failed to attach pasted text as file']);
  });

  test('over-limit .txt still surfaces through the existing pipeline contract', async () => {
    const h = await setup();
    h.setAddAttachedFileImpl(async (file: File) => {
      h.calls.attached.push(file);
      return false;
    });
    // Size enforcement lives in input-store (100 MB); the paste layer only
    // needs to honor a rejection without falling back to inline insertion.
    const text = 'g'.repeat(OVERSIZED_PASTE_TEXT_THRESHOLD + 5);
    const { event } = fakeClipboardEvent({ text });
    await h.handler(event);
    expect(h.calls.attached).toHaveLength(1);
    expect(h.calls.inserted).toHaveLength(0);
    expect(toastErrors.length).toBe(1);
  });
});
