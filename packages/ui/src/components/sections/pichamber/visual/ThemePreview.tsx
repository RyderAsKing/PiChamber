import React from 'react';
import type { Theme, ThemeMode } from '@/types/theme';

/** Schematic of the app in a theme's own colours for the Settings theme picker; fixed px on purpose so it ignores the padding scale. */
export const ThemePreview: React.FC<{ theme: Theme }> = React.memo(
  function ThemePreview({ theme }) {
    return (
      <div
        data-theme-preview={theme.metadata.id}
        className="flex h-full w-full"
        style={{ backgroundColor: theme.colors.surface.background }}
      >
        <div
          className="flex w-[38%] shrink-0 flex-col gap-[4px] overflow-hidden border-r p-[5px]"
          style={{
            backgroundColor: theme.colors.surface.muted,
            borderColor: theme.colors.interactive.border,
          }}
        >
          <div
            className="flex items-center rounded-[3px] px-[3px] py-[3px]"
            style={{ backgroundColor: theme.colors.interactive.selection }}
          >
            <div
              className="h-[3px] w-[70%] rounded-full opacity-60"
              style={{ backgroundColor: theme.colors.surface.foreground }}
            />
          </div>
          <div className="flex items-center rounded-[3px] px-[3px] py-[3px]">
            <div
              className="h-[3px] w-[85%] rounded-full opacity-60"
              style={{ backgroundColor: theme.colors.surface.foreground }}
            />
          </div>
          <div className="flex items-center rounded-[3px] px-[3px] py-[3px]">
            <div
              className="h-[3px] w-[55%] rounded-full opacity-60"
              style={{ backgroundColor: theme.colors.surface.foreground }}
            />
          </div>
        </div>

        <div className="flex min-w-[0px] flex-1 flex-col gap-[4px] overflow-hidden p-[6px]">
          <div
            className="h-[3px] w-[80%] rounded-full opacity-70"
            style={{ backgroundColor: theme.colors.surface.foreground }}
          />
          <div
            className="h-[3px] w-[55%] rounded-full opacity-40"
            style={{ backgroundColor: theme.colors.surface.foreground }}
          />
          <div className="flex items-center gap-[3px]">
            <div
              className="h-[3px] w-[18%] rounded-full"
              style={{ backgroundColor: theme.colors.syntax.base.keyword }}
            />
            <div
              className="h-[3px] w-[30%] rounded-full"
              style={{ backgroundColor: theme.colors.syntax.base.string }}
            />
            <div
              className="h-[3px] w-[22%] rounded-full"
              style={{ backgroundColor: theme.colors.syntax.base.function }}
            />
          </div>
          <div
            className="mt-auto flex h-[11px] items-center justify-end rounded-[3px] border px-[2px]"
            style={{
              backgroundColor: theme.colors.surface.elevated,
              borderColor: theme.colors.interactive.border,
            }}
          >
            <div
              className="h-[5px] w-[9px] rounded-full"
              style={{ backgroundColor: theme.colors.primary.base }}
            />
          </div>
        </div>
      </div>
    );
  },
);

/** Schematic of the app in light, dark, or split system mode for the Settings color mode picker. */
export const ColorModePreview: React.FC<{
  mode: ThemeMode;
  lightTheme: Theme | null | undefined;
  darkTheme: Theme | null | undefined;
}> = ({ mode, lightTheme, darkTheme }) => {
  return (
    <div data-color-mode-preview={mode} className="relative h-full w-full">
      {mode === 'light' && lightTheme && <ThemePreview theme={lightTheme} />}
      {mode === 'dark' && darkTheme && <ThemePreview theme={darkTheme} />}
      {mode === 'system' && (
        <>
          {lightTheme && <ThemePreview theme={lightTheme} />}
          {darkTheme && (
            <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
              <ThemePreview theme={darkTheme} />
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** Compact swatch of a theme's own colours, shown beside its name in the theme selects; fixed px so it ignores the padding scale. */
export const ThemeSwatch: React.FC<{ theme: Theme }> = ({ theme }) => (
  <span
    aria-hidden
    data-theme-swatch={theme.metadata.id}
    className="inline-flex h-[16px] w-[30px] shrink-0 items-center justify-center gap-[3px] rounded-[4px] border"
    style={{ backgroundColor: theme.colors.surface.background, borderColor: theme.colors.interactive.border }}
  >
    <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: theme.colors.primary.base }} />
    <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: theme.colors.syntax.base.keyword }} />
    <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: theme.colors.syntax.base.string }} />
  </span>
);

