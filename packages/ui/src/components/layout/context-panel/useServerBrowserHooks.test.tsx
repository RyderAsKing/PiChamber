import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import type { FrameHeader } from '@/lib/serverBrowser/protocol';

import { createFrameScheduler } from './useServerBrowserFrames';
import { useServerBrowserInput } from './useServerBrowserInput';

const header = (width: number): FrameHeader => ({ width, height: 100 } as FrameHeader);
// Lets resolved decodes run their paint and ack.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

describe('createFrameScheduler', () => {
  const image = (width: number) => {
    const decoded = { width, height: 100, closed: false, close: () => { decoded.closed = true; } };
    return decoded;
  };

  test('paints the newest waiting frame and acks every frame once', async () => {
    const decodes: Array<ReturnType<typeof deferred<ReturnType<typeof image>>>> = [];
    const painted: number[] = [];
    let acks = 0;
    const scheduler = createFrameScheduler({
      decode: () => { const next = deferred<ReturnType<typeof image>>(); decodes.push(next); return next.promise; },
      paint: (_image, frame) => { painted.push(frame.width); },
      ack: () => { acks += 1; },
    });
    scheduler.onFrame(header(1), new Uint8Array());
    scheduler.onFrame(header(2), new Uint8Array());
    scheduler.onFrame(header(3), new Uint8Array());
    expect(acks).toBe(1); // frame 2, replaced while waiting
    decodes[0].resolve(image(1));
    await settle();
    decodes[1].resolve(image(3));
    await settle();
    expect(painted).toEqual([1, 3]);
    expect(acks).toBe(3);
  });

  test('drops a frame still decoding for the old socket after a reset', async () => {
    const decodes: Array<ReturnType<typeof deferred<ReturnType<typeof image>>>> = [];
    const painted: number[] = [];
    let acks = 0;
    const scheduler = createFrameScheduler({
      decode: () => { const next = deferred<ReturnType<typeof image>>(); decodes.push(next); return next.promise; },
      paint: (_image, frame) => { painted.push(frame.width); },
      ack: () => { acks += 1; },
    });
    scheduler.onFrame(header(1), new Uint8Array());
    scheduler.onFrame(header(2), new Uint8Array());
    scheduler.reset();
    scheduler.onFrame(header(10), new Uint8Array());
    const stale = image(1);
    decodes[0].resolve(stale);
    await settle();
    expect(stale.closed).toBe(true);
    expect(painted).toEqual([]);
    expect(acks).toBe(0);
    expect(decodes).toHaveLength(2); // the old socket's waiting frame never starts
    decodes[1].resolve(image(10));
    await settle();
    expect(painted).toEqual([10]);
    expect(acks).toBe(1);
  });
});

type InputOptions = Parameters<typeof useServerBrowserInput>[0];
type InputResult = ReturnType<typeof useServerBrowserInput>;

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
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  restores.splice(0).forEach((restore) => restore());
});

const renderInput = async (overrides: Partial<InputOptions>) => {
  let latest: InputResult | null = null;
  const sent: Array<Record<string, unknown>> = [];
  const picks: Array<{ x: number; y: number }> = [];
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const options: InputOptions = {
    send: (message) => { sent.push(message); return true; },
    canvasRef: { current: canvas as unknown as HTMLCanvasElement },
    headerRef: { current: { width: 100, height: 100, scrollX: 0, scrollY: 0 } as unknown as FrameHeader },
    areaHeight: () => 100,
    inspecting: false,
    onInspectHover: () => undefined,
    onInspectPick: (point) => { picks.push(point); },
    ...overrides,
  };
  const Probe = () => {
    latest = useServerBrowserInput(options);
    return null;
  };
  const dom = installMinimalDom();
  restores.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => { root.render(<Probe />); });
  const pointer = (fields: Record<string, unknown>) => ({
    clientX: 10, clientY: 20, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse',
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault: () => undefined, currentTarget: canvas, ...fields,
  }) as unknown as React.PointerEvent<HTMLCanvasElement>;
  return { input: () => latest as unknown as InputResult, sent, picks, pointer };
};

describe('useServerBrowserInput', () => {
  test('a touch tap while inspecting picks the element instead of clicking the page', async () => {
    const { input, sent, picks, pointer } = await renderInput({ inspecting: true });
    input().canvasHandlers.onPointerDown(pointer({ pointerType: 'touch' }));
    input().canvasHandlers.onPointerUp(pointer({ pointerType: 'touch', buttons: 0 }));
    expect(picks).toHaveLength(1);
    expect(sent.filter((message) => message.type === 'mouse')).toEqual([]);
  });

  test('releases a forwarded press when its pointer is cancelled', async () => {
    const { input, sent, pointer } = await renderInput({});
    input().canvasHandlers.onPointerDown(pointer({ button: 2, buttons: 2 }));
    input().canvasHandlers.onPointerMove(pointer({ clientX: 30, buttons: 2 }));
    input().canvasHandlers.onPointerCancel(pointer({ buttons: 0 }));
    input().canvasHandlers.onPointerCancel(pointer({ buttons: 0 }));
    const ups = sent.filter((message) => message.action === 'up');
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ type: 'mouse', button: 'right', buttons: 0 });
    expect(ups[0].x).toBe(sent.filter((message) => message.action === 'move').at(-1)?.x);
  });
});
