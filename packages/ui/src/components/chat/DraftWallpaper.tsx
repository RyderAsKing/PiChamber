import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { parseColor } from '@/lib/theme/contrast';
import { useUIStore } from '@/stores/useUIStore';
import {
  ASCII_CELL,
  ASCII_RAMP,
  DITHER_CELL_PX,
  asciiIndex,
  bayerThreshold,
  createWallpaperField,
  fillWallpaper,
  type Wallpaper,
} from '@/lib/wallpaper';

/** Redraws wait for the pane to stop resizing, so a drag costs one rebuild. */
const RESIZE_SETTLE_MS = 120;

/** Moving wallpapers draw this often; the drift is slow, so more buys nothing. */
const FRAME_INTERVAL_MS = 1000 / 12;

/** How much ink a lit cell takes. Dark themes need a touch more to show. */
const INK_ALPHA = {
  dither: { light: 0.11, dark: 0.13 },
  ascii: { light: 0.15, dark: 0.18 },
} as const;

type Ink = { r: number; g: number; b: number };

/** Draws one frame at `seconds`. Built once per size, theme and style. */
type Painter = (seconds: number) => void;

function createDitherPainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number): Painter | null {
  const field = createWallpaperField(width, height, DITHER_CELL_PX, DITHER_CELL_PX);
  // One canvas pixel per dot, scaled up crisply by CSS.
  canvas.width = field.cols;
  canvas.height = field.rows;
  const context = canvas.getContext('2d');
  if (!context || field.cols === 0 || field.rows === 0) return null;
  const image = context.createImageData(field.cols, field.rows);
  const pixels = new Uint32Array(image.data.buffer);
  // Packs the RGBA bytes into one word in the platform's byte order.
  const color = new Uint32Array(new Uint8ClampedArray([ink.r, ink.g, ink.b, Math.round(alpha * 255)]).buffer)[0];
  const thresholds = Float32Array.from(field.cells, (cell) => bayerThreshold(cell % field.cols, Math.floor(cell / field.cols)));
  const densities = new Float32Array(field.cells.length);
  return (seconds) => {
    fillWallpaper(field, seconds, densities);
    pixels.fill(0);
    for (let i = 0; i < densities.length; i += 1) {
      if (densities[i] > thresholds[i]) pixels[field.cells[i]] = color;
    }
    context.putImageData(image, 0, 0);
  };
}

function createAsciiPainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number): Painter | null {
  const field = createWallpaperField(width, height, ASCII_CELL.width, ASCII_CELL.height);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;

  // Each character is drawn once into a strip and copied from there, so a
  // frame never lays out text.
  const cellW = Math.ceil(ASCII_CELL.width * scale);
  const cellH = Math.ceil(ASCII_CELL.height * scale);
  const atlas = document.createElement('canvas');
  atlas.width = cellW * ASCII_RAMP.length;
  atlas.height = cellH;
  const atlasContext = atlas.getContext('2d');
  if (!atlasContext) return null;
  const family = getComputedStyle(canvas).getPropertyValue('--font-mono').trim() || 'monospace';
  atlasContext.font = `${11 * scale}px ${family}`;
  atlasContext.textAlign = 'center';
  atlasContext.textBaseline = 'middle';
  atlasContext.fillStyle = `rgb(${ink.r} ${ink.g} ${ink.b} / ${alpha})`;
  for (let i = 1; i < ASCII_RAMP.length; i += 1) {
    atlasContext.fillText(ASCII_RAMP[i], i * cellW + cellW / 2, cellH / 2);
  }

  const densities = new Float32Array(field.cells.length);
  // What each listed cell shows now; 255 makes the first frame draw them all.
  const shown = new Uint8Array(field.cells.length).fill(255);
  context.clearRect(0, 0, canvas.width, canvas.height);
  return (seconds) => {
    fillWallpaper(field, seconds, densities);
    for (let i = 0; i < densities.length; i += 1) {
      const index = asciiIndex(densities[i]);
      if (index === shown[i]) continue;
      shown[i] = index;
      const cell = field.cells[i];
      const x = Math.round((cell % field.cols) * ASCII_CELL.width * scale);
      const y = Math.round(Math.floor(cell / field.cols) * ASCII_CELL.height * scale);
      context.clearRect(x, y, cellW, cellH);
      if (index > 0) context.drawImage(atlas, index * cellW, 0, cellW, cellH, x, y, cellW, cellH);
    }
  };
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true,
  );
  React.useEffect(() => {
    const media = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * Wallpaper behind the new-session screen, in the theme's ink, hidden from
 * assistive technology. When it moves, its bands drift at 12 frames a second;
 * the browser stops the loop in hidden tabs, and reduced motion keeps it
 * still. Nothing renders when the setting is None.
 */
export const DraftWallpaper: React.FC = () => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const reducedMotion = usePrefersReducedMotion();
  if (wallpaper === 'none') return null;
  return <WallpaperCanvas wallpaper={wallpaper} moving={motion && !reducedMotion} />;
};

const WallpaperCanvas: React.FC<{ wallpaper: Exclude<Wallpaper, 'none'>; moving: boolean }> = ({ wallpaper, moving }) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  // How far the drift has got, so a resize or theme change does not jump it back.
  const secondsRef = React.useRef(0);

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
    const paint = wallpaper === 'dither'
      ? createDitherPainter(canvas, size.width, size.height, ink, alpha)
      : createAsciiPainter(canvas, size.width, size.height, ink, alpha);
    if (!paint) return;
    paint(secondsRef.current);
    if (!moving) return;

    let frame = 0;
    let last = performance.now();
    let sinceDraw = 0;
    const tick = (now: number) => {
      // Capped, so time spent in a hidden tab (no frames run) is not skipped over.
      const elapsed = Math.min(now - last, 250);
      last = now;
      secondsRef.current += elapsed / 1000;
      sinceDraw += elapsed;
      if (sinceDraw >= FRAME_INTERVAL_MS) {
        sinceDraw %= FRAME_INTERVAL_MS;
        paint(secondsRef.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [foreground, moving, size, variant, wallpaper]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      data-draft-wallpaper-moving={moving ? 'true' : 'false'}
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
