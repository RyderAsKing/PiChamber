import React from 'react';

import { isPasteShortcut, modifiersOf, toPagePoint, type FrameHeader } from '@/lib/serverBrowser/protocol';

const MULTI_CLICK_MS = 500;
const TOUCH_TAP_SLOP_PX = 6;
const BUTTON_NAMES = ['left', 'middle', 'right'] as const;

const isMacPlatform = (): boolean => (
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
);

type Point = { x: number; y: number };

type Options = {
  send: (message: Record<string, unknown>) => boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  headerRef: React.RefObject<FrameHeader | null>;
  /** The page area's height, for wheel events that scroll by pages. */
  areaHeight: () => number;
  /** While inspecting, pointer moves hover elements and a click picks one. */
  inspecting: boolean;
  onInspectHover: (point: Point) => void;
  onInspectPick: (point: Point) => void;
};

/**
 * This device's mouse, touch, wheel, and keyboard input for a server
 * browser tab, in page coordinates. Keys go through a hidden textarea that
 * holds focus while the page is in use, so text input methods and paste
 * work; touch taps click and touch drags scroll.
 */
export const useServerBrowserInput = ({ send, canvasRef, headerRef, areaHeight, inspecting, onInspectHover, onInspectPick }: Options) => {
  const keyboardRef = React.useRef<HTMLTextAreaElement | null>(null);
  const clickRef = React.useRef<{ at: number; x: number; y: number; count: number }>({ at: 0, x: 0, y: 0, count: 0 });
  const touchRef = React.useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const areaHeightRef = React.useRef(areaHeight);
  areaHeightRef.current = areaHeight;

  const pagePoint = React.useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const header = headerRef.current;
    if (!canvas || !header) return null;
    return toPagePoint(clientX, clientY, canvas.getBoundingClientRect(), header);
  }, [canvasRef, headerRef]);

  const focusKeyboard = React.useCallback(() => keyboardRef.current?.focus({ preventScroll: true }), []);

  // Wheel needs a non-passive listener to keep the panel from scrolling.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? areaHeightRef.current() : 1;
      send({ type: 'mouse', action: 'wheel', ...point, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiersOf(event) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, pagePoint, send]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // The press belongs to the page. Cancelling it also stops the mousedown
    // that would move focus off the keyboard input.
    event.preventDefault();
    focusKeyboard();
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    if (event.pointerType === 'touch') {
      touchRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 3 || event.button === 4) {
      send({ type: event.button === 3 ? 'back' : 'forward' });
      return;
    }
    if (inspecting) {
      if (event.button === 0) onInspectPick(point);
      return;
    }
    const button = BUTTON_NAMES[event.button] ?? 'left';
    const click = clickRef.current;
    const now = performance.now();
    const near = Math.abs(event.clientX - click.x) < 5 && Math.abs(event.clientY - click.y) < 5;
    click.count = now - click.at < MULTI_CLICK_MS && near ? Math.min(3, click.count + 1) : 1;
    click.at = now;
    click.x = event.clientX;
    click.y = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    send({ type: 'mouse', action: 'down', ...point, button, buttons: event.buttons, clickCount: click.count, modifiers: modifiersOf(event) });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    const touch = touchRef.current;
    if (event.pointerType === 'touch') {
      if (!touch || touch.id !== event.pointerId) return;
      if (Math.abs(event.clientX - touch.startX) > TOUCH_TAP_SLOP_PX || Math.abs(event.clientY - touch.startY) > TOUCH_TAP_SLOP_PX) touch.moved = true;
      if (!touch.moved) return;
      const header = headerRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = header && rect.width > 0 ? header.width / rect.width : 1;
      send({ type: 'mouse', action: 'wheel', ...point, deltaX: (touch.lastX - event.clientX) * scale, deltaY: (touch.lastY - event.clientY) * scale });
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      return;
    }
    if (inspecting) {
      onInspectHover(point);
      return;
    }
    send({ type: 'mouse', action: 'move', ...point, buttons: event.buttons, modifiers: modifiersOf(event) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    if (event.pointerType === 'touch') {
      const touch = touchRef.current;
      touchRef.current = null;
      if (!touch || touch.id !== event.pointerId || touch.moved) return;
      send({ type: 'mouse', action: 'down', ...point, button: 'left', buttons: 1, clickCount: 1 });
      send({ type: 'mouse', action: 'up', ...point, button: 'left', buttons: 0, clickCount: 1 });
      return;
    }
    if (inspecting || event.button === 3 || event.button === 4) return;
    const button = BUTTON_NAMES[event.button] ?? 'left';
    send({ type: 'mouse', action: 'up', ...point, button, buttons: event.buttons, clickCount: clickRef.current.count || 1, modifiers: modifiersOf(event) });
  };

  const keyMessage = (action: 'down' | 'up', event: React.KeyboardEvent<HTMLTextAreaElement>) => ({
    type: 'key',
    action,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    location: event.nativeEvent.location,
    repeat: event.repeat,
    modifiers: modifiersOf(event),
  });

  const canvasHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: () => { touchRef.current = null; },
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };

  const keyboardHandlers = {
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      // Let the paste event read this device's clipboard.
      if (isPasteShortcut(event, isMacPlatform())) return;
      event.preventDefault();
      event.stopPropagation();
      send(keyMessage('down', event));
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.stopPropagation();
      send(keyMessage('up', event));
    },
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (text) send({ type: 'text', text });
    },
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      if (event.data) send({ type: 'text', text: event.data });
      event.currentTarget.value = '';
    },
    onInput: (event: React.FormEvent<HTMLTextAreaElement>) => {
      if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = '';
    },
  };

  return { keyboardRef, focusKeyboard, canvasHandlers, keyboardHandlers };
};
