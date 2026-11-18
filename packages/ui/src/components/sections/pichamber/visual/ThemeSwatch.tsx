import React from 'react';
import type { Theme } from '@/types/theme';

/**
 * A theme's own colours at pill size for the Settings theme picker: its page
 * with a sidebar strip, a line of text and its accent. Fixed px on purpose so
 * it ignores the padding scale. Decorative; the pill's label names the theme.
 */
export const ThemeSwatch: React.FC<{ theme: Theme }> = React.memo(function ThemeSwatch({ theme }) {
  const { surface, interactive, primary } = theme.colors;
  return (
    <span
      aria-hidden
      data-theme-swatch={theme.metadata.id}
      className="flex h-[22px] w-[34px] shrink-0 overflow-hidden rounded-[5px] border"
      style={{ backgroundColor: surface.background, borderColor: interactive.border }}
    >
      <span className="w-[30%] border-r" style={{ backgroundColor: surface.muted, borderColor: interactive.border }} />
      <span className="flex flex-1 flex-col justify-center gap-[3px] px-[4px]">
        <span className="h-[2px] w-full rounded-full opacity-70" style={{ backgroundColor: surface.foreground }} />
        <span className="h-[3px] w-[60%] rounded-full" style={{ backgroundColor: primary.base }} />
      </span>
    </span>
  );
});
