import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-interactive-hover transition-colors';

/**
 * Persistent top-left titlebar controls (window chrome + collapsed-sidebar toggle).
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so window chrome never remounts while the sidebar
 * animates. When the sidebar is closed, the sessions toggle lives here so it
 * remains reachable; when the sidebar is open, that toggle sits next to
 * New session instead. Its height tracks `--oc-header-height` and its left
 * padding clears the OS window controls via `--oc-titlebar-left-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * so the header can reserve matching space when the sidebar is collapsed.
 * The sidebar strip carves a matching no-drag region under this overlay so
 * Electron window-drag does not swallow the PiChamber menu while the sidebar
 * is open.
 */
export const TitlebarLeftControls: React.FC = () => {
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const showToggle = !isSidebarOpen;
  const showWindowControls = usesFramelessChrome && windowControlsSide === 'left';
  const showAppMenu = usesFramelessChrome;
  const showOverlay = showToggle || showWindowControls || showAppMenu;
  // A toggle-only cluster is always a 2rem button. Measuring it on every
  // sidebar toggle flushes the just-invalidated layout tree; only native
  // window chrome can make this cluster's width variable.
  const hasVariableWidthControls = showWindowControls || showAppMenu;

  const handleOpenWindowsAppMenu = React.useCallback(() => {
    void invokeDesktop('desktop_show_app_menu').catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const publishWidth = (width: number) => {
      document.documentElement.style.setProperty('--oc-titlebar-controls-width', `${Math.round(width)}px`);
    };
    const publishOverlayWidth = (width: number) => {
      document.documentElement.style.setProperty('--oc-titlebar-overlay-width', `${Math.round(width)}px`);
    };

    if (!hasVariableWidthControls) {
      return;
    }

    const cluster = clusterRef.current;
    const overlay = overlayRef.current;
    if (!cluster || !overlay) {
      publishWidth(0);
      publishOverlayWidth(0);
      return;
    }

    const publishNodeWidth = () => {
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(cluster.getBoundingClientRect().width, cluster.scrollWidth);
      publishWidth(width);
      publishOverlayWidth(overlay.getBoundingClientRect().width);
    };

    publishNodeWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishNodeWidth);
    observer.observe(cluster);
    observer.observe(overlay);
    return () => {
      observer.disconnect();
    };
  }, [hasVariableWidthControls]);

  if (!showOverlay) {
    return null;
  }

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      ref={overlayRef}
      className="app-region-no-drag absolute left-0 top-0 z-40 flex select-none items-center pr-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingLeft: 'var(--oc-titlebar-left-inset, 0.75rem)',
      }}
    >
      <div ref={clusterRef} className="flex items-center gap-2">
        {showWindowControls ? (
          <WindowsWindowControls visible position="left" />
        ) : null}

        {showAppMenu ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={"Open PiChamber menu"}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{"PiChamber menu"}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        {showToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={"Open sessions"}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="layout-left" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{`Open sessions (${toggleShortcut})`}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
};
