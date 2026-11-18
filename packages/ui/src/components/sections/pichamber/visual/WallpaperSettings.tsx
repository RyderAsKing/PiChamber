import React from 'react';

import { WallpaperCanvas } from '@/components/chat/DraftWallpaper';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
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
import { wallpaperCanMove, type Wallpaper, type WallpaperImageStyle } from '@/lib/wallpaper';
import { removeWallpaperPicture, uploadWallpaperPicture } from '@/lib/wallpaperPicture';
import { useUIStore } from '@/stores/useUIStore';

import { WALLPAPER_OPTIONS, WALLPAPER_PICTURE_STYLE_OPTIONS } from './visualSettingsConstants';

const WALLPAPER_GRID_CLASS = 'grid max-w-[40rem] grid-cols-2 gap-2 space-y-0 @xl:grid-cols-4 @xl:gap-3';

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Settings → Appearance → Wallpaper: a tile per pattern, the uploaded
 * picture and how it shows, and whether patterns move. Every choice is a
 * server UI setting, so each device on the server shows the same screen.
 */
export const WallpaperSettings: React.FC = () => {
  const wallpaper = useUIStore((state) => state.draftWallpaper);
  const setWallpaper = useUIStore((state) => state.setDraftWallpaper);
  const motion = useUIStore((state) => state.draftWallpaperMotion);
  const setMotion = useUIStore((state) => state.setDraftWallpaperMotion);
  const pictureStyle = useUIStore((state) => state.draftWallpaperImageStyle);
  const setPictureStyle = useUIStore((state) => state.setDraftWallpaperImageStyle);
  const pictureVersion = useUIStore((state) => state.draftWallpaperImageVersion);
  const setPictureVersion = useUIStore((state) => state.setDraftWallpaperImageVersion);
  const picture = useWallpaperPicture(pictureVersion);
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
      setWallpaper('image');
      void updateDesktopSettings({ draftWallpaperImageVersion: version, draftWallpaper: 'image' });
    } catch (error) {
      toast.error(errorMessage(error, 'The picture could not be saved'));
    } finally {
      setBusy(null);
    }
  }, [setPictureVersion, setWallpaper]);

  const handleRemove = React.useCallback(async () => {
    setBusy('remove');
    try {
      await removeWallpaperPicture();
      setPictureVersion(null);
      const next = wallpaper === 'image' ? 'none' : wallpaper;
      setWallpaper(next);
      void updateDesktopSettings({ draftWallpaperImageVersion: null, draftWallpaper: next });
    } catch (error) {
      toast.error(errorMessage(error, 'The picture could not be removed'));
    } finally {
      setBusy(null);
    }
  }, [setPictureVersion, setWallpaper, wallpaper]);

  const openPicker = () => fileInputRef.current?.click();

  const renderPreview = (value: Wallpaper) => {
    if (value === 'none') return null;
    if (value === 'image') {
      return picture ? (
        <WallpaperCanvas wallpaper="image" picture={picture} pictureStyle={pictureStyle} moving={false} />
      ) : (
        <span className="flex h-full items-center justify-center typography-meta text-muted-foreground">
          {busy === 'upload' ? 'Uploading…' : 'Choose a picture'}
        </span>
      );
    }
    return <WallpaperCanvas wallpaper={value} moving={false} />;
  };

  return (
    <>
      <SettingsControlGroup
        title={'Wallpaper'}
        info={'Behind the new-session screen, kept clear around the title and composer. Patterns are drawn in the theme\'s text colour. Applies to every device connected to this server.'}
        settingsItem="appearance.wallpaper"
      >
        <SettingsRadioGroup aria-label={'Wallpaper'} className={WALLPAPER_GRID_CLASS}>
          {WALLPAPER_OPTIONS.map((option) => (
            <SettingsPreviewOption
              key={option.value}
              selected={wallpaper === option.value}
              // A picture tile with nothing uploaded asks for one first.
              onSelect={() => (option.value === 'image' && !pictureVersion ? openPicker() : choose(option.value))}
              label={option.label}
              ariaLabel={option.label}
              preview={renderPreview(option.value)}
              disabled={option.value === 'image' && busy !== null}
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
      <SettingsInset settingsItem="appearance.wallpaper-picture">
        <SettingsFieldRow
          label={'Picture'}
          info={'Your own picture, stored on this server. Show it as it is, dimmed, or drawn as dither or ASCII in the theme\'s text colour.'}
        >
          <SettingsChipGroup<WallpaperImageStyle>
            value={pictureStyle}
            options={WALLPAPER_PICTURE_STYLE_OPTIONS.map((option) => ({ ...option, disabled: !pictureVersion }))}
            onChange={(value) => {
              setPictureStyle(value);
              void updateDesktopSettings({ draftWallpaperImageStyle: value });
            }}
            aria-label={'Picture style'}
          />
          <Button type="button" size="xs" variant="outline" onClick={openPicker} disabled={busy !== null}>
            {busy === 'upload' ? 'Uploading…' : pictureVersion ? 'Replace' : 'Choose'}
          </Button>
          {pictureVersion ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => void handleRemove()} disabled={busy !== null}>
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
          ) : null}
        </SettingsFieldRow>
      </SettingsInset>

      {/* Always shown so search can find it; it has nothing to move for None, Grain or a picture. */}
      <SettingsInset settingsItem="appearance.wallpaper-motion">
        <SettingsCheckboxRow
          checked={motion}
          onChange={(enabled) => {
            setMotion(enabled);
            void updateDesktopSettings({ draftWallpaperMotion: enabled });
          }}
          disabled={!wallpaperCanMove(wallpaper)}
          label={'Moving wallpaper'}
          info={'Patterns drift slowly. Grain and pictures stay still, and so does everything when your system asks for reduced motion.'}
          ariaLabel={'Moving wallpaper'}
        />
      </SettingsInset>
    </>
  );
};
