import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  sidebarContentInsetX,
  sidebarRowIconClassName,
  sidebarRowLabelClassName,
} from './utils';

/** Fallback for `--oc-titlebar-left-inset`: the titlebar's own left padding (see `Header.tsx`). */
const titlebarLeftInsetFallback = '0.75rem';

type Props = {
  onNewSession: () => void;
  showSidebarToggle: boolean;
  touchFriendly?: boolean;
};

export function SidebarNav(props: Props): React.ReactNode {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));

  return (
    <div
      // pr-3 puts the toggle's icon (16px in a 32px button) on the session rows' right content edge.
      className="app-region-drag select-none flex h-[var(--oc-header-height,3rem)] shrink-0 items-center pr-3"
    >
      {/* Traffic-lights / window-controls inset stays a window drag area. */}
      <div
        aria-hidden
        className="shrink-0 self-stretch"
        style={{ width: `var(--oc-titlebar-left-inset, ${titlebarLeftInsetFallback})` }}
      />
      {/* Electron drag regions ignore z-index of overlays. Carve no-drag under
          the TitlebarLeftControls menu so it stays clickable while the sidebar
          is open. Width is overlay minus the inset already reserved above. */}
      <div
        aria-hidden
        className="app-region-no-drag shrink-0 self-stretch"
        style={{
          width: `max(0px, calc(var(--oc-titlebar-overlay-width, 0px) - var(--oc-titlebar-left-inset, ${titlebarLeftInsetFallback})))`,
        }}
      />
      <div className="app-region-no-drag flex min-w-0 flex-1 items-center gap-1.5">
        <button
          type="button"
          onClick={props.onNewSession}
          className={cn(
            'group flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            props.touchFriendly && 'min-h-11',
          )}
          // Start the icon on the session rows' content line.
          // Past OS window chrome or the titlebar overlay it only keeps a 3px nudge.
          style={{
            paddingLeft: `max(3px, calc(${sidebarContentInsetX} - max(var(--oc-titlebar-left-inset, ${titlebarLeftInsetFallback}), var(--oc-titlebar-overlay-width, 0px))))`,
          }}
        >
          <Icon name="chat-new" className={cn(sidebarRowIconClassName, 'text-current')} />
          <span className={sidebarRowLabelClassName}>{"New session"}</span>
        </button>
        {props.showSidebarToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={"Hide sessions"}
              >
                <Icon name="layout-left" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{`Hide sessions (${toggleShortcut})`}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
