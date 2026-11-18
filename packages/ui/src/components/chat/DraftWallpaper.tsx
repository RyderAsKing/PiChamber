import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { parseColor } from '@/lib/theme/contrast';
import { cn } from '@/lib/utils';
import { wallpaperCanMove, type Wallpaper } from '@/lib/wallpaper';
import { useUIStore } from '@/stores/useUIStore';

import { createWallpaperPainter, isPixelatedWallpaper, paintPictureBackdrop } from './lib/wallpaperPainters';

/** Redraws wait for the pane to stop resizing, so a drag costs one rebuild. */
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
export const DraftWallpaper: React.FC = () => {
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
      // Fades out above the bottom edge, where a phone's composer bar starts,
      // so the pattern never ends on a hard line. Drawn into the canvas: a CSS
      // mask on a canvas this large sometimes left a strip unmasked in Chrome.
      fade
    />
  );
};

type WallpaperCanvasProps = {
  wallpaper: Wallpaper;
  picture?: ImageBitmap | null;
  moving: boolean;
  className?: string;
  fade?: boolean;
};

/**
 * One wallpaper drawn to fill its box; also used for the Settings previews.
 * The picture and the pattern have a canvas each, so a moving pattern never
 * redraws the picture.
 */
export const WallpaperCanvas: React.FC<WallpaperCanvasProps> = ({
  wallpaper,
  picture = null,
  moving,
  className,
  fade = false,
}) => {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const pictureRef = React.useRef<HTMLCanvasElement | null>(null);
  const patternRef = React.useRef<HTMLCanvasElement | null>(null);
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  // How far the drift has got, so a resize or theme change does not jump it back.
  const secondsRef = React.useRef(0);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const rect = box.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
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
  }, []);

  React.useEffect(() => {
    const canvas = pictureRef.current;
    if (!canvas || !size || !picture) return;
    paintPictureBackdrop({ canvas, width: size.width, height: size.height, picture, variant, underPattern: wallpaper !== 'none', fade });
  }, [fade, picture, size, variant, wallpaper]);

  React.useEffect(() => {
    const canvas = patternRef.current;
    const ink = parseColor(foreground);
    if (!canvas || !size || !ink || wallpaper === 'none') return;
    const painter = createWallpaperPainter({ canvas, width: size.width, height: size.height, ink, variant, wallpaper, picture, fade });
    if (!painter) return;
    painter.draw(secondsRef.current);
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
      if (sinceDraw >= painter.frameMs) {
        sinceDraw %= painter.frameMs;
        painter.draw(secondsRef.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fade, foreground, moving, picture, size, variant, wallpaper]);

  const layer = 'absolute inset-0 h-full w-full';
  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      data-draft-wallpaper-picture={picture ? 'true' : 'false'}
      data-draft-wallpaper-moving={moving ? 'true' : 'false'}
      className={cn('pointer-events-none relative h-full w-full select-none', className)}
    >
      {picture ? <canvas ref={pictureRef} className={layer} /> : null}
      {wallpaper !== 'none' ? (
        <canvas
          // A new canvas per pattern: a canvas cannot switch between pixel and smooth scaling cleanly mid-life.
          key={wallpaper}
          ref={patternRef}
          className={layer}
          style={{ imageRendering: isPixelatedWallpaper(wallpaper) ? 'pixelated' : undefined }}
        />
      ) : null}
    </div>
  );
};
