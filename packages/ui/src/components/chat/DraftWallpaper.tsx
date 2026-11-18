import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { parseColor } from '@/lib/theme/contrast';
import { cn } from '@/lib/utils';
import { wallpaperCanMove, type Wallpaper, type WallpaperImageStyle } from '@/lib/wallpaper';
import { useUIStore } from '@/stores/useUIStore';

import { createWallpaperPainter, isPixelatedWallpaper } from './lib/wallpaperPainters';

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
 * Wallpaper behind the new-session screen, in the theme's ink (or the
 * server's picture), hidden from assistive technology. When it moves, its
 * pattern drifts at 6 frames a second; the browser stops the loop in
 * hidden tabs, and reduced motion keeps it still. Nothing renders when the
 * setting is None, or for a picture that is missing or still loading.
 */
export const DraftWallpaper: React.FC = () => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const pictureStyle = useUIStore((state) => state.draftWallpaperImageStyle);
  const pictureVersion = useUIStore((state) => state.draftWallpaperImageVersion);
  const picture = useWallpaperPicture(wallpaper === 'image' ? pictureVersion : null);
  const reducedMotion = usePrefersReducedMotion();
  if (wallpaper === 'none' || (wallpaper === 'image' && !picture)) return null;
  return (
    <WallpaperCanvas
      wallpaper={wallpaper}
      picture={picture}
      pictureStyle={pictureStyle}
      moving={motion && !reducedMotion && wallpaperCanMove(wallpaper)}
      className="absolute inset-0 -z-10"
      // Fades out above the bottom edge, where a phone's composer bar starts,
      // so the pattern never ends on a hard line.
      fade
    />
  );
};

type WallpaperCanvasProps = {
  wallpaper: Exclude<Wallpaper, 'none'>;
  picture?: ImageBitmap | null;
  pictureStyle?: WallpaperImageStyle;
  moving: boolean;
  className?: string;
  fade?: boolean;
};

/** One wallpaper drawn to fill its box; also used for the Settings previews. */
export const WallpaperCanvas: React.FC<WallpaperCanvasProps> = ({
  wallpaper,
  picture = null,
  pictureStyle = 'photo',
  moving,
  className,
  fade = false,
}) => {
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
    if (!canvas || !size || !ink) return;
    const painter = createWallpaperPainter({
      canvas,
      width: size.width,
      height: size.height,
      ink,
      variant,
      wallpaper,
      picture,
      pictureStyle,
    });
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
  }, [foreground, moving, picture, pictureStyle, size, variant, wallpaper]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-draft-wallpaper={wallpaper}
      data-draft-wallpaper-moving={moving ? 'true' : 'false'}
      className={cn('pointer-events-none h-full w-full select-none', className)}
      style={{
        maskImage: fade ? 'linear-gradient(to bottom, black 45%, transparent 78%)' : undefined,
        imageRendering: isPixelatedWallpaper(wallpaper) ? 'pixelated' : undefined,
      }}
    />
  );
};
