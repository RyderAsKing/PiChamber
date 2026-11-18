import React from 'react';

import { WallpaperCanvas } from '@/components/chat/DraftWallpaper';
import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsInset,
  SettingsPreviewOption,
  SettingsRadioGroup,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useWallpaperPicture } from '@/hooks/useWallpaperPicture';
import { updateDesktopSettings } from '@/lib/persistence';
import { wallpaperCanMove, type Wallpaper } from '@/lib/wallpaper';
import { removeWallpaperPicture, uploadWallpaperPicture } from '@/lib/wallpaperPicture';
import { useUIStore } from '@/stores/useUIStore';

import { WALLPAPER_OPTIONS } from './visualSettingsConstants';

const WALLPAPER_GRID_CLASS = 'grid max-w-[40rem] grid-cols-2 gap-2 space-y-0 @xl:grid-cols-4 @xl:gap-3';

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Settings → Appearance → Wallpaper: a tile per pattern, the uploaded
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
  const { picture } = useWallpaperPicture(pictureVersion);
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
    return <WallpaperCanvas wallpaper={value} picture={previewPicture} moving={false} />;
  };

  return (
    <>
      <SettingsControlGroup
        title={'Wallpaper'}
        info={'Behind the new-session screen, kept clear around the title and composer. Patterns are drawn in the theme\'s text colour, or in your picture\'s colours when it is on. Applies to every device connected to this server.'}
        settingsItem="appearance.wallpaper"
      >
        <SettingsRadioGroup aria-label={'Wallpaper'} className={WALLPAPER_GRID_CLASS}>
          {WALLPAPER_OPTIONS.map((option) => (
            <SettingsPreviewOption
              key={option.value}
              selected={wallpaper === option.value}
              onSelect={() => choose(option.value)}
              label={option.label}
              ariaLabel={option.label}
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
      <SettingsInset settingsItem="appearance.wallpaper-picture" className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsFieldRow
          label={'Picture'}
          info={'Your own PNG, JPEG or WebP, stored on this server. With None it shows dimmed on its own; with a pattern it shows fainter and the pattern takes its colours. Dither, ASCII and Halftone also follow its light and dark.'}
        >
          <Button type="button" size="xs" variant="outline" onClick={openPicker} disabled={busy !== null}>
            {busy === 'upload' ? 'Uploading…' : pictureVersion ? 'Replace' : 'Choose'}
          </Button>
          {pictureVersion ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => void handleRemove()} disabled={busy !== null}>
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
          ) : null}
        </SettingsFieldRow>
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

      {/* Always shown so search can find it; with nothing chosen there is nothing to show. */}
      <SettingsInset settingsItem="appearance.wallpaper-sessions">
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
      <SettingsInset settingsItem="appearance.wallpaper-motion">
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
    </>
  );
};
