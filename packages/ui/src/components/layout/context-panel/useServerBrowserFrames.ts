import React from 'react';

import type { FrameHeader } from '@/lib/serverBrowser/protocol';

type Pending = { header: FrameHeader; jpeg: Uint8Array };
type Decoded = { width: number; height: number; close: () => void };

/**
 * Schedules a socket's frames: decodes one at a time, paints only the
 * newest waiting frame, and calls `ack` once per frame (painted or dropped)
 * so the server sends the next. `reset` starts over for a new socket: a
 * decode still running for the old one is closed unpainted and unacked, so
 * it cannot cover a newer frame or count against the new socket's frames.
 */
export const createFrameScheduler = <T extends Decoded>({
  decode,
  paint,
  ack,
}: {
  decode: (jpeg: Uint8Array) => Promise<T>;
  paint: (image: T, header: FrameHeader) => void;
  ack: () => void;
}) => {
  let state = { busy: false, pending: null as Pending | null };

  const draw = async (header: FrameHeader, jpeg: Uint8Array) => {
    const current = state;
    current.busy = true;
    let image: T | null = null;
    try {
      image = await decode(jpeg);
    } catch {
      // A frame that fails to decode is skipped; the next one replaces it.
    }
    if (state !== current) {
      image?.close();
      return;
    }
    try {
      if (image) paint(image, header);
    } finally {
      image?.close();
      ack();
      current.busy = false;
      const next = current.pending;
      current.pending = null;
      if (next) void draw(next.header, next.jpeg);
    }
  };

  return {
    onFrame(header: FrameHeader, jpeg: Uint8Array) {
      if (state.busy) {
        // Keep only the newest waiting frame; release the one it replaces.
        if (state.pending) ack();
        state.pending = { header, jpeg };
        return;
      }
      void draw(header, jpeg);
    },
    reset() {
      state = { busy: false, pending: null };
    },
  };
};

/** Paints a server browser tab's frames on a canvas (see `createFrameScheduler`). */
export const useServerBrowserFrames = (ack: () => void) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // The page size and scroll of the frame on screen, for input coordinates.
  const headerRef = React.useRef<FrameHeader | null>(null);
  const [frameSize, setFrameSize] = React.useState<{ width: number; height: number } | null>(null);
  const ackRef = React.useRef(ack);
  ackRef.current = ack;

  const [scheduler] = React.useState(() => createFrameScheduler({
    decode: (jpeg) => createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })),
    paint: (bitmap, header) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
      }
      const previous = headerRef.current;
      headerRef.current = header;
      if (!previous || previous.width !== header.width || previous.height !== header.height) {
        setFrameSize({ width: header.width, height: header.height });
      }
    },
    ack: () => ackRef.current(),
  }));

  const onFrame = React.useCallback((header: FrameHeader, jpeg: Uint8Array) => scheduler.onFrame(header, jpeg), [scheduler]);
  /** A new socket: frames still on their way belong to the old one. */
  const reset = React.useCallback(() => scheduler.reset(), [scheduler]);

  return { canvasRef, headerRef, frameSize, onFrame, reset };
};
