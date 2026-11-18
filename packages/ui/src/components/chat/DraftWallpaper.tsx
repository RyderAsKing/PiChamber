import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { parseColor } from '@/lib/theme/contrast';
import { cn } from '@/lib/utils';
import { wallpaperCanMove, type Wallpaper } from '@/lib/wallpaper';
import { useUIStore } from '@/stores/useUIStore';

import { createWallpaperPainter, isPixelatedWallpaper, paintPictureBackdrop, wallpaperCanvasSize } from './lib/wallpaperPainters';

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

/**
 * Wallpaper behind the new-session screen, hidden from assistive technology:
 * a pattern in the theme's ink, or with the server's picture turned on, the
 * picture with the pattern in its colours over it. When it moves, the pattern
 * drifts at 6 frames a second; the browser stops the loop in hidden tabs, and
 * reduced motion keeps it still. Nothing renders while the picture loads; if
 * it cannot load, the pattern is drawn without it.
 */
export const DraftWallpaper: React.FC<{ fade: boolean }> = ({ fade }) => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const showPicture = useUIStore((state) => state.draftWallpaperPicture);
  const pictureVersion = useUIStore((state) => state.draftWallpaperImageVersion);
  const { picture, pending } = useWallpaperPicture(showPicture ? pictureVersion : null);
  const reducedMotion = usePrefersReducedMotion();
  if (pending || (wallpaper === 'none' && !picture)) return null;
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

type WallpaperCanvasProps = {
  wallpaper: Wallpaper;
  picture?: ImageBitmap | null;
  moving: boolean;
  className?: string;
  fade?: boolean;
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

/** Fixed CSS size, centred on the box; the box clips whatever overhangs. */
const centred = (size: Size): React.CSSProperties => ({
  position: 'absolute',
  left: `calc(50% - ${size.width / 2}px)`,
  top: `calc(50% - ${size.height / 2}px)`,
  width: `${size.width}px`,
  height: `${size.height}px`,
});

/**
 * One wallpaper drawn to cover its box; also used for the Settings previews.
 * The picture and the pattern have a canvas each, so a moving pattern never
 * redraws the picture. Each canvas keeps a fixed size centred on the box, so
 * a box that changes size never stretches it.
 */
export const WallpaperCanvas: React.FC<WallpaperCanvasProps> = ({
  wallpaper,
  picture = null,
  moving,
  className,
  fade = false,
  sizeTo = 'box',
}) => {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const pictureRef = React.useRef<HTMLCanvasElement | null>(null);
  const patternRef = React.useRef<HTMLCanvasElement | null>(null);
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const windowSize = useWindowSize(sizeTo === 'window');
  const boxSize = useBoxSize(boxRef, sizeTo === 'box');
  const area = sizeTo === 'window' ? windowSize : boxSize;
  const pictureWidth = area ? wallpaperCanvasSize('none', area.width, area.height).width : 0;
  const pictureHeight = area ? wallpaperCanvasSize('none', area.width, area.height).height : 0;
  const patternWidth = area ? wallpaperCanvasSize(wallpaper, area.width, area.height).width : 0;
  const patternHeight = area ? wallpaperCanvasSize(wallpaper, area.width, area.height).height : 0;

  React.useLayoutEffect(() => {
    const canvas = pictureRef.current;
    if (!canvas || !picture || pictureWidth === 0) return;
    paintPictureBackdrop({ canvas, width: pictureWidth, height: pictureHeight, picture, variant, underPattern: wallpaper !== 'none', fade });
  }, [fade, picture, pictureHeight, pictureWidth, variant, wallpaper]);

  // A layout effect, so the canvas is resized and redrawn in the same frame
  // and never shows cleared.
  React.useLayoutEffect(() => {
    const canvas = patternRef.current;
    const ink = parseColor(foreground);
    if (!canvas || patternWidth === 0 || !ink || wallpaper === 'none') return;
    const painter = createWallpaperPainter({ canvas, width: patternWidth, height: patternHeight, ink, variant, wallpaper, picture, fade });
    if (!painter) return;
    painter.draw(driftSeconds);
    if (!moving) return;

    let frame = 0;
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
    return () => cancelAnimationFrame(frame);
  }, [fade, foreground, moving, patternHeight, patternWidth, picture, variant, wallpaper]);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      data-draft-wallpaper-picture={picture ? 'true' : 'false'}
      data-draft-wallpaper-moving={moving ? 'true' : 'false'}
      className={cn('pointer-events-none relative h-full w-full select-none overflow-hidden', className)}
    >
      {picture && pictureWidth > 0 ? (
        <canvas ref={pictureRef} style={centred({ width: pictureWidth, height: pictureHeight })} />
      ) : null}
      {wallpaper !== 'none' && patternWidth > 0 ? (
        <canvas
          // A new canvas per pattern: a canvas cannot switch between pixel and smooth scaling cleanly mid-life.
          key={wallpaper}
          ref={patternRef}
          style={{
            ...centred({ width: patternWidth, height: patternHeight }),
            imageRendering: isPixelatedWallpaper(wallpaper) ? 'pixelated' : undefined,
          }}
        />
      ) : null}
    </div>
  );
};
