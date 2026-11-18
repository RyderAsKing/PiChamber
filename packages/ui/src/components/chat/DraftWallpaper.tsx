import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { parseColor } from '@/lib/theme/contrast';
import { cn } from '@/lib/utils';
import { wallpaperCanMove, type Wallpaper, type WallpaperFade } from '@/lib/wallpaper';
import { useUIStore } from '@/stores/useUIStore';

import {
  createWallpaperPainter,
  isPixelatedWallpaper,
  paintPictureBackdrop,
  wallpaperCanvasSize,
  type WallpaperPainter,
} from './lib/wallpaperPainters';

/** Redraws wait for a resize to settle, so a drag costs one rebuild. */
const RESIZE_SETTLE_MS = 120;

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

/** The chosen wallpaper and, if it is turned on, the server's picture. */
function useWallpaperChoice() {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const showPicture = useUIStore((state) => state.draftWallpaperPicture);
  const pictureVersion = useUIStore((state) => state.draftWallpaperImageVersion);
  const { picture, pending } = useWallpaperPicture(showPicture ? pictureVersion : null);
  // Nothing while the picture loads, rather than the pattern without it and then with it.
  const empty = pending || (wallpaper === 'none' && !picture);
  return { wallpaper, picture, empty };
}

/**
 * Wallpaper behind the new-session screen, hidden from assistive technology:
 * a pattern in the theme's ink, or with the server's picture turned on, the
 * picture with the pattern in its colours over it. When it moves, the pattern
 * drifts at 6 frames a second; the browser stops the loop in hidden tabs, and
 * reduced motion keeps it still. Nothing renders while the picture loads; if
 * it cannot load, the pattern is drawn without it.
 */
export const DraftWallpaper: React.FC<{ fade: WallpaperFade }> = ({ fade }) => {
  const { wallpaper, picture, empty } = useWallpaperChoice();
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const reducedMotion = usePrefersReducedMotion();
  if (empty) return null;
  return (
    <WallpaperCanvas
      wallpaper={wallpaper}
      picture={picture}
      moving={motion && !reducedMotion && wallpaperCanMove(wallpaper)}
      className="absolute inset-0 -z-10"
      // Drawn for the whole window, so opening a sidebar or panel only
      // uncovers more of it rather than redrawing it.
      sizeTo="window"
      // Drawn into the canvas: a CSS mask on a canvas this large sometimes
      // left a strip unmasked in Chrome.
      fade={fade}
    />
  );
};

/**
 * The same wallpaper at the top of an open session, when turned on: fainter,
 * faded out well above the messages and composer, and always still, so a
 * session never spends a frame on it while you read or it works.
 */
export const SessionWallpaper: React.FC = () => {
  const enabled = useUIStore((state) => state.draftWallpaperInSessions);
  const { wallpaper, picture, empty } = useWallpaperChoice();
  if (!enabled || empty) return null;
  return (
    <WallpaperCanvas
      wallpaper={wallpaper}
      picture={picture}
      moving={false}
      // A quarter strength: it is a tint behind text, not a picture to look at.
      className="absolute inset-0 -z-10 opacity-25"
      sizeTo="window"
      fade="session"
    />
  );
};

type WallpaperCanvasProps = {
  wallpaper: Wallpaper;
  picture?: ImageBitmap | null;
  moving: boolean;
  className?: string;
  fade?: WallpaperFade;
  /**
   * What the drawing covers. `window` draws for the whole window and centres
   * it on the box, so the box can change size (sidebars, panels) without a
   * redraw; only a window resize redraws. `box` fits the box (previews).
   */
  sizeTo?: 'box' | 'window';
};

type Size = { width: number; height: number };

const sameSize = (a: Size | null, b: Size) => a?.width === b.width && a.height === b.height;

/** The window's size, updated once a resize settles. */
function useWindowSize(enabled: boolean): Size | null {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = React.useState<Size | null>(() => (enabled && typeof window !== 'undefined' ? read() : null));
  React.useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const next = read();
      setSize((previous) => (sameSize(previous, next) ? previous : next));
    };
    update();
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, RESIZE_SETTLE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
  return size;
}

/** An element's size, updated once a resize settles. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>, enabled: boolean): Size | null {
  const [size, setSize] = React.useState<Size | null>(null);
  React.useEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const rect = box.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((previous) => (sameSize(previous, next) ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_SETTLE_MS);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, ref]);
  return size;
}

/**
 * How far the drift has got, shared by every wallpaper on the page, so a
 * redraw, a theme change or the screen mounting again carries on from where
 * it was instead of jumping back.
 */
let driftSeconds = 0;

/** A drawn canvas and the painter that keeps drawing it, if it moves. */
type Layer = { canvas: HTMLCanvasElement; painter: WallpaperPainter | null };

/**
 * Finished full-window canvases, newest last, so going back to a screen
 * re-attaches the one already drawn instead of building it again. A few
 * cover the new-session screen and sessions, each with and without the
 * picture; anything older is dropped.
 */
const LAYER_CACHE_SIZE = 4;
const layerCache = new Map<string, Layer>();

const takeLayer = (key: string): Layer | undefined => {
  const layer = layerCache.get(key);
  if (layer) {
    layerCache.delete(key);
    layerCache.set(key, layer);
  }
  return layer;
};

const keepLayer = (key: string, layer: Layer) => {
  layerCache.set(key, layer);
  while (layerCache.size > LAYER_CACHE_SIZE) {
    const oldest = layerCache.keys().next().value;
    if (oldest === undefined) break;
    layerCache.delete(oldest);
  }
};

const bitmapIds = new WeakMap<ImageBitmap, number>();
let nextBitmapId = 1;
const bitmapId = (bitmap: ImageBitmap | null): number => {
  if (!bitmap) return 0;
  let id = bitmapIds.get(bitmap);
  if (!id) {
    id = nextBitmapId;
    nextBitmapId += 1;
    bitmapIds.set(bitmap, id);
  }
  return id;
};

/** Runs `task` once the page has painted and the browser is idle (or after 300 ms at most). */
const whenIdle = (task: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 300 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 50);
  return () => window.clearTimeout(handle);
};

const FADE_IN_MS = 400;

/** Fixed CSS size, centred on the box; the box clips whatever overhangs. */
const placeCanvas = (canvas: HTMLCanvasElement, size: Size, slot: number, pixelated: boolean) => {
  Object.assign(canvas.style, {
    position: 'absolute',
    left: `calc(50% - ${size.width / 2}px)`,
    top: `calc(50% - ${size.height / 2}px)`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    zIndex: String(slot),
    imageRendering: pixelated ? 'pixelated' : '',
  });
};

type LayerSpec = {
  /** Same key, same drawing: what the cache is looked up by. */
  key: string;
  size: Size;
  pixelated: boolean;
  /** Draws into a fresh canvas; returns a painter to keep drawing it, or null once drawn. */
  build: (canvas: HTMLCanvasElement) => WallpaperPainter | null | 'failed';
};

/**
 * Keeps one layer (`slot` 0 for the picture, 1 for the pattern) in `box`:
 * from the cache if it is there, otherwise built once the page has painted and
 * faded in over whatever it replaces, which only goes once it is covered.
 */
function useLayer(boxRef: React.RefObject<HTMLDivElement | null>, slot: number, spec: LayerSpec | null, moving: boolean, cache: boolean) {
  const specRef = React.useRef(spec);
  specRef.current = spec;
  const key = spec?.key ?? null;
  React.useEffect(() => {
    const box = boxRef.current;
    const current = specRef.current;
    if (!box) return;
    const others = () => [...box.querySelectorAll<HTMLCanvasElement>(`canvas[data-slot="${slot}"]`)];
    if (!current) {
      for (const canvas of others()) canvas.remove();
      return;
    }
    let cancelled = false;
    let frame = 0;
    let retire: ReturnType<typeof setTimeout> | null = null;
    const fadeIn = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const show = (layer: Layer, fresh: boolean) => {
      const { canvas, painter } = layer;
      canvas.dataset.slot = String(slot);
      placeCanvas(canvas, current.size, slot, current.pixelated);
      const replaced = others().filter((other) => other !== canvas);
      if (fresh && fadeIn) {
        canvas.style.transition = '';
        canvas.style.opacity = '0';
        box.appendChild(canvas);
        // Read layout so the starting opacity takes, then fade to full.
        void canvas.offsetWidth;
        canvas.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
        canvas.style.opacity = '1';
        retire = setTimeout(() => replaced.forEach((other) => other.remove()), FADE_IN_MS);
      } else {
        canvas.style.transition = '';
        canvas.style.opacity = '1';
        box.appendChild(canvas);
        replaced.forEach((other) => other.remove());
      }
      if (!moving || !painter) return;
      let last = performance.now();
      let sinceDraw = 0;
      const tick = (now: number) => {
        // Capped, so time spent in a hidden tab (no frames run) is not skipped over.
        const elapsed = Math.min(now - last, 250);
        last = now;
        driftSeconds += elapsed / 1000;
        sinceDraw += elapsed;
        if (sinceDraw >= painter.frameMs) {
          sinceDraw %= painter.frameMs;
          painter.draw(driftSeconds);
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    const cached = cache ? takeLayer(current.key) : undefined;
    let cancelIdle: (() => void) | null = null;
    if (cached) {
      // Catch a moving pattern up with the shared drift before it shows; a
      // still one is already drawn, and grain would redraw every pixel.
      if (moving) cached.painter?.draw(driftSeconds);
      show(cached, false);
    } else {
      cancelIdle = whenIdle(() => {
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        const painter = current.build(canvas);
        if (painter === 'failed') return;
        painter?.draw(driftSeconds);
        const layer = { canvas, painter };
        if (cache) keepLayer(current.key, layer);
        show(layer, true);
      });
    }
    return () => {
      cancelled = true;
      cancelIdle?.();
      cancelAnimationFrame(frame);
      if (retire) clearTimeout(retire);
      // The canvas stays until its replacement covers it, or the box goes.
    };
  }, [boxRef, cache, key, moving, slot]);
}

/**
 * One wallpaper drawn to cover its box; also used for the Settings previews.
 * The picture and the pattern have a canvas each, so a moving pattern never
 * redraws the picture. Each canvas keeps a fixed size centred on the box, so
 * a box that changes size never stretches it. Canvases are built after the
 * page paints and fade in; full-window ones are kept, so coming back to a
 * screen shows them at once.
 */
export const WallpaperCanvas: React.FC<WallpaperCanvasProps> = ({
  wallpaper,
  picture = null,
  moving,
  className,
  fade = 'none',
  sizeTo = 'box',
}) => {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const windowSize = useWindowSize(sizeTo === 'window');
  const boxSize = useBoxSize(boxRef, sizeTo === 'box');
  const area = sizeTo === 'window' ? windowSize : boxSize;
  const scale = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const pictureId = bitmapId(picture);

  const pictureSize = area ? wallpaperCanvasSize('none', area.width, area.height) : null;
  const pictureSpec: LayerSpec | null = picture && pictureSize && pictureSize.width > 0
    ? {
      key: ['picture', pictureId, pictureSize.width, pictureSize.height, scale, variant, wallpaper !== 'none', fade].join('|'),
      size: pictureSize,
      pixelated: false,
      build: (canvas) => {
        paintPictureBackdrop({ canvas, width: pictureSize.width, height: pictureSize.height, picture, variant, underPattern: wallpaper !== 'none', fade });
        return null;
      },
    }
    : null;

  const patternSize = area ? wallpaperCanvasSize(wallpaper, area.width, area.height) : null;
  const ink = parseColor(foreground);
  const patternSpec: LayerSpec | null = wallpaper !== 'none' && patternSize && patternSize.width > 0 && ink
    ? {
      key: ['pattern', wallpaper, pictureId, patternSize.width, patternSize.height, scale, variant, foreground, fade].join('|'),
      size: patternSize,
      pixelated: isPixelatedWallpaper(wallpaper),
      build: (canvas) =>
        createWallpaperPainter({ canvas, width: patternSize.width, height: patternSize.height, ink, variant, wallpaper, picture, fade }) ?? 'failed',
    }
    : null;

  const cache = sizeTo === 'window';
  useLayer(boxRef, 0, pictureSpec, false, cache);
  useLayer(boxRef, 1, patternSpec, moving, cache);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      data-draft-wallpaper-picture={picture ? 'true' : 'false'}
      data-draft-wallpaper-moving={moving ? 'true' : 'false'}
      className={cn('pointer-events-none relative h-full w-full select-none overflow-hidden', className)}
    />
  );
};
