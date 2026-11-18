import React from 'react';

import {
  drawWallpaperSwatch,
  peekWallpaperSwatch,
  pictureThumbnail,
} from '@/components/chat/lib/wallpaperSwatch';
import {
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsInset,
  SettingsPreviewOption,
  SettingsRadioGroup,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { updateDesktopSettings } from '@/lib/persistence';
import { isSoftwareRendering } from '@/lib/softwareRendering';
import { parseColor } from '@/lib/theme/contrast';
import { wallpaperCanMove, type Wallpaper } from '@/lib/wallpaper';
import { removeWallpaperPicture, uploadWallpaperPicture } from '@/lib/wallpaperPicture';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { cn } from '@/lib/utils';

import { WALLPAPER_OPTIONS } from './visualSettingsConstants';

const WALLPAPER_GRID_CLASS = 'grid max-w-[48rem] grid-cols-3 gap-2 space-y-0 @xl:gap-3 @3xl:grid-cols-6';
/** The theme tiles' shape, so the two rows line up as one page. */
const WALLPAPER_TILE_CLASS = 'aspect-[16/10]';

const runWhenIdle = (task: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 200 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
};

/**
 * A wallpaper's tile: a still image of it, drawn once in idle time and kept
 * for the page, so the tiles cost nothing while Settings is open.
 */
const WallpaperSwatch: React.FC<{ wallpaper: Wallpaper; picture: ImageBitmap | null }> = ({ wallpaper, picture }) => {
  const { currentTheme } = useThemeSystem();
  const foreground = currentTheme.colors.surface.foreground;
  const variant = currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
  const options = React.useMemo(() => {
    const ink = parseColor(foreground);
    return ink ? { wallpaper, picture, ink: { r: ink.r, g: ink.g, b: ink.b }, variant } as const : null;
  }, [wallpaper, picture, foreground, variant]);
  const [url, setUrl] = React.useState<string | null | undefined>(() => (options ? peekWallpaperSwatch(options) : null));
  React.useEffect(() => {
    if (!options) return;
    const known = peekWallpaperSwatch(options);
    if (known !== undefined) {
      setUrl(known);
      return;
    }
    setUrl(undefined);
    return runWhenIdle(() => setUrl(drawWallpaperSwatch(options)));
  }, [options]);
  if (!url) return null;
  return <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />;
};

/** The uploaded picture as it is, or an empty frame when there is none. */
const PictureThumbnail: React.FC<{ picture: ImageBitmap | null; pending: boolean }> = ({ picture, pending }) => {
  const url = React.useMemo(() => (picture ? pictureThumbnail(picture) : null), [picture]);
  return (
    <div
      className={cn(
        WALLPAPER_TILE_CLASS,
        'flex w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border',
        url ? 'border-[var(--interactive-border)]' : 'border-dashed border-[var(--interactive-border)]',
      )}
    >
      {url ? (
        <img src={url} alt={'Wallpaper picture'} draggable={false} className="h-full w-full object-cover" />
      ) : (
        <span className="typography-meta text-muted-foreground">{pending ? 'Loading…' : 'No picture'}</span>
      )}
    </div>
  );
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Settings → Appearance → Wallpaper: a still tile per pattern, the uploaded
 * picture and whether it shows behind them, and whether patterns move. With
 * the picture on, the tiles preview each pattern over it. Every choice is a
 * server UI setting, so each device on the server shows the same screen.
 */
export const WallpaperSettings: React.FC = () => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const setWallpaper = useUIStore((state) => state.setDraftWallpaper);
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const setMotion = useUIStore((state) => state.setDraftWallpaperMotion);
  const showPicture = useUIStore((state) => state.draftWallpaperPicture);
  const inSessions = useUIStore((state) => state.draftWallpaperInSessions);
  const setInSessions = useUIStore((state) => state.setDraftWallpaperInSessions);
  const setShowPicture = useUIStore((state) => state.setDraftWallpaperPicture);
  const pictureVersion = useUIStore((state) => state.draftWallpaperImageVersion);
  const setPictureVersion = useUIStore((state) => state.setDraftWallpaperImageVersion);
  const { picture, pending: picturePending } = useWallpaperPicture(pictureVersion);
  const softwareRendering = React.useMemo(() => isSoftwareRendering(), []);
  const previewPicture = showPicture ? picture : null;
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = React.useState<'upload' | 'remove' | null>(null);

  const choose = React.useCallback((value: Wallpaper) => {
    setWallpaper(value);
    void updateDesktopSettings({ draftWallpaper: value });
  }, [setWallpaper]);

  const handlePictureFile = React.useCallback(async (file: File) => {
    setBusy('upload');
    try {
      const { version } = await uploadWallpaperPicture(file);
      setPictureVersion(version);
      setShowPicture(true);
      void updateDesktopSettings({ draftWallpaperImageVersion: version, draftWallpaperPicture: true });
    } catch (error) {
      toast.error(errorMessage(error, 'The picture could not be saved'));
    } finally {
      setBusy(null);
    }
  }, [setPictureVersion, setShowPicture]);

  const handleRemove = React.useCallback(async () => {
    setBusy('remove');
    try {
      await removeWallpaperPicture();
      setPictureVersion(null);
      setShowPicture(false);
      void updateDesktopSettings({ draftWallpaperImageVersion: null, draftWallpaperPicture: false });
    } catch (error) {
      toast.error(errorMessage(error, 'The picture could not be removed'));
    } finally {
      setBusy(null);
    }
  }, [setPictureVersion, setShowPicture]);

  const openPicker = () => fileInputRef.current?.click();

  const renderPreview = (value: Wallpaper) => {
    if (value === 'none' && !previewPicture) return null;
    return <WallpaperSwatch wallpaper={value} picture={previewPicture} />;
  };

  return (
    // Its own spacing: the section's wider gap would split these related rows.
    <div className="space-y-4">
      <SettingsControlGroup
        title={'Wallpaper'}
        info={'Behind the new-session screen, kept clear around the title and composer. Patterns are drawn in the theme\'s text colour, or in your picture\'s colours when it is on. Applies to every device connected to this server.'}
        settingsItem="appearance.wallpaper"
        // Status, so it stays visible: nothing is turned off, it only costs more.
        description={softwareRendering
          ? 'Hardware acceleration is off in this browser, so wallpapers are drawn on the processor. They still work; Moving wallpaper uses more of it.'
          : undefined}
      >
        <SettingsRadioGroup aria-label={'Wallpaper'} className={WALLPAPER_GRID_CLASS}>
          {WALLPAPER_OPTIONS.map((option) => (
            <SettingsPreviewOption
              key={option.value}
              selected={wallpaper === option.value}
              onSelect={() => choose(option.value)}
              label={option.label}
              ariaLabel={option.label}
              previewClassName={WALLPAPER_TILE_CLASS}
              preview={renderPreview(option.value)}
            />
          ))}
        </SettingsRadioGroup>
      </SettingsControlGroup>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        data-wallpaper-picture-input=""
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handlePictureFile(file);
        }}
      />

      {/* Always shown so search can find it; without a picture only Choose works. */}
      <SettingsInset settingsItem="appearance.wallpaper-picture" className="space-y-3 pt-0">
        <div className="flex items-center gap-4">
          <PictureThumbnail picture={picture} pending={pictureVersion !== null && picturePending} />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <span className="typography-settings-field-label text-foreground">{'Picture'}</span>
              <SettingsInfoHint>
                {'Your own PNG, JPEG or WebP, stored on this server. With None it shows dimmed on its own; with a pattern it shows fainter and the pattern takes its colours. Dither, ASCII and Halftone also follow its light and dark.'}
              </SettingsInfoHint>
            </div>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="xs" variant="outline" onClick={openPicker} disabled={busy !== null}>
                {busy === 'upload' ? 'Uploading…' : pictureVersion ? 'Replace' : 'Choose'}
              </Button>
              {pictureVersion ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => void handleRemove()} disabled={busy !== null}>
                  {busy === 'remove' ? 'Removing…' : 'Remove'}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <SettingsCheckboxRow
          checked={showPicture && pictureVersion !== null}
          onChange={(enabled) => {
            setShowPicture(enabled);
            void updateDesktopSettings({ draftWallpaperPicture: enabled });
          }}
          disabled={!pictureVersion || busy !== null}
          label={'Show behind the pattern'}
          ariaLabel={'Show picture behind the pattern'}
        />
      </SettingsInset>

      <div className="space-y-3">
        {/* Always shown so search can find it; with nothing chosen there is nothing to show. */}
        <SettingsInset settingsItem="appearance.wallpaper-sessions" className="pt-0">
          <SettingsCheckboxRow
            checked={inSessions}
            onChange={(enabled) => {
              setInSessions(enabled);
              void updateDesktopSettings({ draftWallpaperInSessions: enabled });
            }}
            disabled={wallpaper === 'none' && !(showPicture && pictureVersion)}
            label={'Show in open sessions'}
            info={'Also show the wallpaper at the top of open sessions: fainter, faded out above the messages, and always still.'}
            ariaLabel={'Show wallpaper in open sessions'}
          />
        </SettingsInset>

        {/* Always shown so search can find it; it has nothing to move for None or Grain. */}
        <SettingsInset settingsItem="appearance.wallpaper-motion" className="pt-0">
          <SettingsCheckboxRow
            checked={motion}
            onChange={(enabled) => {
              setMotion(enabled);
              void updateDesktopSettings({ draftWallpaperMotion: enabled });
            }}
            disabled={!wallpaperCanMove(wallpaper)}
            label={'Moving wallpaper'}
            info={'Patterns drift slowly, over your picture too. Grain and the picture itself stay still, and so does everything when your system asks for reduced motion.'}
            ariaLabel={'Moving wallpaper'}
          />
        </SettingsInset>
      </div>
    </div>
  );
};
