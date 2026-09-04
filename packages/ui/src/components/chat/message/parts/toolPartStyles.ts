import type { CSSProperties } from 'react';

import { toolDisplayStyles } from '@/lib/typography';
import { cn } from '@/lib/utils';

// Tool rows mix 15px sans titles with 13px mono metadata. Keep both on the
// same 20px line box so flex centering does not pull descriptions or timers
// toward the top beside a taller desktop title line.
const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-markdown)] !leading-5 tracking-normal';
export const TOOL_ROW_TITLE_CLASS = cn('typography-markdown font-medium', TOOL_ROW_TEXT_CLASS);
// Tool target: mono 13px leading-5.
// Action stays sans markdown (15px); target uses semantic code size (13px).
export const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-code font-mono', '!text-[length:var(--text-code)] !leading-5 tracking-normal');

export const TOOL_COLLAPSED_CUSTOM_STYLE: CSSProperties = {
    ...toolDisplayStyles.getCollapsedStyles(),
    padding: 0,
    overflow: 'visible',
};

export const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

export const TOOL_ERROR_ICON_STYLE: CSSProperties = { color: 'var(--status-error)' };
export const TOOL_NORMAL_ICON_STYLE: CSSProperties = { color: 'var(--tools-icon)' };
export const TOOL_ERROR_TITLE_STYLE: CSSProperties = { color: 'var(--status-error)' };
export const TOOL_NORMAL_TITLE_STYLE: CSSProperties = {
    color: 'color-mix(in srgb, var(--tools-title) 72%, var(--tools-description))',
};

export const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

export const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};
