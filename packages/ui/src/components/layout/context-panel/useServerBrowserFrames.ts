import React from 'react';

import type { FrameHeader } from '@/lib/serverBrowser/protocol';

type Pending = { header: FrameHeader; jpeg: Uint8Array };

/**
 * Paints a server browser tab's frames on a canvas: decodes off the main
 * path, draws only the newest waiting frame, and calls `ack` once per frame
 * (drawn or dropped) so the server sends the next.
 */
export const useServerBrowserFrames = (ack: () => void) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // The page size and scroll of the frame on screen, for input coordinates.
  const headerRef = React.useRef<FrameHeader | null>(null);
  const [frameSize, setFrameSize] = React.useState<{ width: number; height: number } | null>(null);
  const drawRef = React.useRef<{ busy: boolean; pending: Pending | null }>({ busy: false, pending: null });
  const ackRef = React.useRef(ack);
  ackRef.current = ack;

  const draw = React.useCallback(async (header: FrameHeader, jpeg: Uint8Array) => {
    const state = drawRef.current;
    state.busy = true;
    try {
      const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
      const previous = headerRef.current;
      headerRef.current = header;
      if (!previous || previous.width !== header.width || previous.height !== header.height) {
        setFrameSize({ width: header.width, height: header.height });
      }
    } catch {
      // A frame that fails to decode is skipped; the next one replaces it.
    } finally {
      ackRef.current();
      state.busy = false;
      const next = state.pending;
      state.pending = null;
      if (next) void draw(next.header, next.jpeg);
    }
  }, []);

  const onFrame = React.useCallback((header: FrameHeader, jpeg: Uint8Array) => {
    const state = drawRef.current;
    if (state.busy) {
      // Keep only the newest waiting frame; release the one it replaces.
      if (state.pending) ackRef.current();
      state.pending = { header, jpeg };
      return;
    }
    void draw(header, jpeg);
  }, [draw]);

  /** A new socket: frames still on their way belong to the old one. */
  const reset = React.useCallback(() => {
    drawRef.current = { busy: false, pending: null };
  }, []);

  return { canvasRef, headerRef, frameSize, onFrame, reset };
};
