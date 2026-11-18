import type { Theme } from '@/types/theme';
import { parseColor } from './contrast';

/**
 * Share of the theme's primary text colour used for each state, by variant.
 * Dark themes need a little more ink than light ones for the same step.
 */
const INK = {
  dark: { hover: 0.06, active: 0.1, selection: 0.15, border: 0.13, borderHover: 0.26 },
  light: { hover: 0.04, active: 0.07, selection: 0.1, border: 0.15, borderHover: 0.28 },
} as const;

const alphaHex = (alpha: number): string => Math.round(alpha * 255).toString(16).padStart(2, '0');

/**
 * Derives hover, pressed, border and (opaque) selection colours from the
 * theme's primary text at fixed alphas. Every theme then gets the same state
 * ladder, and the states read the same on the page, the sidebar, and cards,
 * because a translucent fill takes the colour of whatever is behind it.
 *
 * A translucent selection is kept: themes tint it on purpose. Text colours
 * are not touched; they stay solid and contrast-checked. Unparseable
 * foregrounds leave the theme as it is.
 */
export function withInkStates(theme: Theme): Theme {
  const ink = parseColor(theme.colors.surface.foreground);
  if (!ink) return theme;
  const rgb = `#${[ink.r, ink.g, ink.b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
  const steps = INK[theme.metadata.variant === 'dark' ? 'dark' : 'light'];
  const at = (alpha: number) => `${rgb}${alphaHex(alpha)}`;
  const { interactive } = theme.colors;
  const selection = parseColor(interactive.selection);
  return {
    ...theme,
    colors: {
      ...theme.colors,
      interactive: {
        ...interactive,
        hover: at(steps.hover),
        active: at(steps.active),
        selection: selection && selection.a < 1 ? interactive.selection : at(steps.selection),
        border: at(steps.border),
        borderHover: at(steps.borderHover),
      },
    },
  };
}
