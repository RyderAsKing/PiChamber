import React from 'react';

interface ComposerVoiceVisualizerProps {
  subscribeLevel(listener: (level: number) => void): () => void;
}

const VISUALIZER_HEIGHT = 48;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
const MIN_LEVEL = 0.08;
const MAX_HISTORY_BARS = 512;
const MAX_DEVICE_PIXEL_RATIO = 2;

type CanvasSize = {
  width: number;
  height: number;
  pixelRatio: number;
};

type LevelHistory = {
  values: number[];
  cursor: number;
  count: number;
};

const appendHistory = (history: LevelHistory, value: number) => {
  history.values[history.cursor] = value;
  history.cursor = (history.cursor + 1) % MAX_HISTORY_BARS;
  history.count = Math.min(MAX_HISTORY_BARS, history.count + 1);
};

const readHistory = (history: LevelHistory, limit: number): number[] => {
  const count = Math.min(history.count, limit);
  const start = (history.cursor - count + MAX_HISTORY_BARS) % MAX_HISTORY_BARS;
  return Array.from({ length: count }, (_, index) => history.values[(start + index) % MAX_HISTORY_BARS]);
};

const drawBar = (
  context: CanvasRenderingContext2D,
  x: number,
  size: CanvasSize,
  level: number,
  color: string,
) => {
  const width = Math.max(1, Math.round(BAR_WIDTH * size.pixelRatio));
  const availableHeight = Math.max(1, size.height - Math.round(8 * size.pixelRatio));
  const height = Math.max(Math.round(2 * size.pixelRatio), Math.round(availableHeight * level));
  const y = Math.round((size.height - height) / 2);

  context.globalAlpha = 0.35 + level * 0.65;
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(x, y, width, height, width / 2);
  context.fill();
  context.globalAlpha = 1;
};

export function ComposerVoiceVisualizer({ subscribeLevel }: ComposerVoiceVisualizerProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const contextRef = React.useRef<CanvasRenderingContext2D | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const levelRef = React.useRef(0);
  const colorRef = React.useRef('');
  const sizeRef = React.useRef<CanvasSize>({ width: 0, height: 0, pixelRatio: 1 });
  const historyRef = React.useRef<LevelHistory>({
    values: Array.from({ length: MAX_HISTORY_BARS }, () => MIN_LEVEL),
    cursor: 0,
    count: 0,
  });

  const redraw = React.useCallback(() => {
    const context = contextRef.current;
    const size = sizeRef.current;
    if (!context || size.width <= 0 || size.height <= 0 || !colorRef.current) return;

    context.clearRect(0, 0, size.width, size.height);
    const pitch = Math.max(1, Math.round(BAR_PITCH * size.pixelRatio));
    const slots = Math.ceil(size.width / pitch);
    const history = readHistory(historyRef.current, slots);
    const historyStart = slots - history.length;

    for (let index = 0; index < slots; index += 1) {
      const level = index >= historyStart ? history[index - historyStart] : MIN_LEVEL;
      const x = size.width - Math.round(BAR_WIDTH * size.pixelRatio) - ((slots - 1 - index) * pitch);
      drawBar(context, x, size, level, colorRef.current);
    }
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    contextRef.current = context;

    const resize = (width: number) => {
      const pixelRatio = Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
      const nextSize = {
        width: Math.max(1, Math.round(width * pixelRatio)),
        height: Math.round(VISUALIZER_HEIGHT * pixelRatio),
        pixelRatio,
      };
      const current = sizeRef.current;
      if (current.width === nextSize.width && current.height === nextSize.height && current.pixelRatio === nextSize.pixelRatio) return;
      sizeRef.current = nextSize;
      canvas.width = nextSize.width;
      canvas.height = nextSize.height;
      colorRef.current = getComputedStyle(canvas).color;
      redraw();
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number' && width > 0) resize(width);
    });
    resizeObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => {
      colorRef.current = getComputedStyle(canvas).color;
      redraw();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      contextRef.current = null;
    };
  }, [redraw]);

  React.useEffect(() => {
    const paint = () => {
      frameRef.current = null;
      const canvas = canvasRef.current;
      const context = contextRef.current;
      const size = sizeRef.current;
      if (!canvas || !context || size.width <= 0 || !colorRef.current) return;

      const level = Math.max(MIN_LEVEL, levelRef.current);
      const pitch = Math.max(1, Math.round(BAR_PITCH * size.pixelRatio));
      if (size.width > pitch) {
        context.globalCompositeOperation = 'copy';
        context.drawImage(canvas, pitch, 0, size.width - pitch, size.height, 0, 0, size.width - pitch, size.height);
        context.globalCompositeOperation = 'source-over';
      }
      context.clearRect(Math.max(0, size.width - pitch), 0, pitch, size.height);
      drawBar(context, size.width - Math.round(BAR_WIDTH * size.pixelRatio), size, level, colorRef.current);
      appendHistory(historyRef.current, level);
    };

    const unsubscribe = subscribeLevel((level) => {
      levelRef.current = level;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
    });
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [subscribeLevel]);

  return (
    <canvas
      ref={canvasRef}
      className="h-12 w-full text-primary"
      aria-hidden="true"
    />
  );
}
