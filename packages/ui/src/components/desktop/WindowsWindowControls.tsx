import React, { useEffect } from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { invokeDesktop } from '@/lib/desktop';

type WindowsWindowControlsProps = {
  visible: boolean;
};

/**
 * Fixed right-side classic controls for frameless Windows/Linux desktop
 * windows: minimize, maximize/restore, close in Windows order.
 *
 * macOS keeps native OS-owned traffic lights and never renders this cluster.
 * Web and mobile render no window chrome.
 */
export const WindowsWindowControls = React.memo(function WindowsWindowControls({
  visible,
}: WindowsWindowControlsProps) {
  const [isMaximized, setIsMaximized] = React.useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let disposed = false;
    void invokeDesktop<{ maximized?: boolean }>('desktop_get_current_window_state')
      .then((state) => {
        if (!disposed) {
          setIsMaximized(Boolean(state?.maximized));
        }
      })
      .catch(() => {});

    const handleMaximizedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ maximized?: boolean }>).detail;
      setIsMaximized(Boolean(detail?.maximized));
    };

    window.addEventListener('pichamber:window-maximized-changed', handleMaximizedChange);
    return () => {
      disposed = true;
      window.removeEventListener('pichamber:window-maximized-changed', handleMaximizedChange);
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  // Classic Windows-style square buttons with a taller h-12 hit target.
  const buttonClassName =
    'app-region-no-drag inline-flex h-12 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

  return (
    <div className="app-region-no-drag ml-1 flex h-12 shrink-0 items-center" aria-label={"Window controls"}>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => { void invokeDesktop('desktop_minimize_current_window'); }}
        title={"Minimize window"}
        aria-label={"Minimize window"}
      >
        <Icon name="subtract" className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => {
          void invokeDesktop<{ maximized?: boolean }>('desktop_toggle_current_window_maximized')
            .then((state) => setIsMaximized(Boolean(state?.maximized)))
            .catch(() => {});
        }}
        title={isMaximized ? "Restore window" : "Maximize window"}
        aria-label={isMaximized ? "Restore window" : "Maximize window"}
      >
        <Icon name={isMaximized ? 'fullscreen-exit' : 'checkbox-blank'} className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cn(buttonClassName, 'hover:bg-status-error hover:text-status-error-foreground')}
        onClick={() => { void invokeDesktop('desktop_close_current_window'); }}
        title={"Close window"}
        aria-label={"Close window"}
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>
  );
});
