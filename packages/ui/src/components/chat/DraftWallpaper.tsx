import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { parseColor } from '@/lib/theme/contrast';
import { useUIStore } from '@/stores/useUIStore';
import {
  ASCII_CELL,
  DITHER_CELL_PX,
  asciiFor,
  bayerThreshold,
  sampleWallpaper,
  type Wallpaper,
} from '@/lib/wallpaper';

/** Redraws wait for the pane to stop resizing, so a drag costs one draw. */
const RESIZE_SETTLE_MS = 120;

/** How much ink a lit cell takes. Dark themes need a touch more to show. */
const INK_ALPHA = {
  dither: { light: 0.11, dark: 0.13 },
  ascii: { light: 0.15, dark: 0.18 },
} as const;

type Ink = { r: number; g: number; b: number };

function drawDither(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number) {
  const grid = sampleWallpaper(width, height, DITHER_CELL_PX, DITHER_CELL_PX);
  // One canvas pixel per dot, scaled up crisply by CSS.
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const context = canvas.getContext('2d');
  if (!context || grid.cols === 0 || grid.rows === 0) return;
  const image = context.createImageData(grid.cols, grid.rows);
  const a = Math.round(alpha * 255);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const index = row * grid.cols + col;
      if (grid.values[index] <= bayerThreshold(col, row)) continue;
      const offset = index * 4;
      image.data[offset] = ink.r;
      image.data[offset + 1] = ink.g;
      image.data[offset + 2] = ink.b;
      image.data[offset + 3] = a;
    }
  }
  context.putImageData(image, 0, 0);
}

function drawAscii(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number) {
  const grid = sampleWallpaper(width, height, ASCII_CELL.width, ASCII_CELL.height);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(scale, scale);
  const family = getComputedStyle(canvas).getPropertyValue('--font-mono').trim() || 'monospace';
  context.font = `11px ${family}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = `rgb(${ink.r} ${ink.g} ${ink.b} / ${alpha})`;
  for (let row = 0; row < grid.rows; row += 1) {
    const y = row * ASCII_CELL.height + ASCII_CELL.height / 2;
    for (let col = 0; col < grid.cols; col += 1) {
      const char = asciiFor(grid.values[row * grid.cols + col]);
      if (char === ' ') continue;
      context.fillText(char, col * ASCII_CELL.width + ASCII_CELL.width / 2, y);
    }
  }
}

/**
 * Static wallpaper behind the new-session screen, in the theme's ink. It is
 * drawn once per size, theme and style, never animated, and hidden from
 * assistive technology. Nothing renders when the setting is None.
 */
export const DraftWallpaper: React.FC = () => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  if (wallpaper === 'none') return null;
  return <WallpaperCanvas wallpaper={wallpaper} />;
};

const WallpaperCanvas: React.FC<{ wallpaper: Exclude<Wallpaper, 'none'> }> = ({ wallpaper }) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_SETTLE_MS);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ink = parseColor(foreground);
    if (!canvas || !size || !ink || size.width === 0 || size.height === 0) return;
    const alpha = INK_ALPHA[wallpaper][variant];
    if (wallpaper === 'dither') drawDither(canvas, size.width, size.height, ink, alpha);
    else drawAscii(canvas, size.width, size.height, ink, alpha);
  }, [foreground, size, variant, wallpaper]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none"
      style={{
        // Fades out above the bottom edge, where a phone's composer bar
        // starts, so the pattern never ends on a hard line.
        maskImage: 'linear-gradient(to bottom, black 45%, transparent 78%)',
        imageRendering: wallpaper === 'dither' ? 'pixelated' : undefined,
      }}
    />
  );
};
