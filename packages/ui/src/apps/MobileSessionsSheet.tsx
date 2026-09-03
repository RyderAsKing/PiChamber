import React from 'react';
import { createPortal } from 'react-dom';

import { SessionSidebar } from '@/components/session/SessionSidebar';
import { cn } from '@/lib/utils';
import { MOBILE_DRAWER_DURATION_MS, MOBILE_DRAWER_EASING, useDrawerSwipe } from './useDrawerSwipe';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' renders a 72%-width overlay; 'sidebar' is the tablet persistent pane. */
  variant?: 'drawer' | 'sidebar';
  /** External refs so the shell can drive the drawer without querySelector per-frame */
  drawerRefExternal?: React.RefObject<HTMLDivElement | null>;
  scrimRefExternal?: React.RefObject<HTMLButtonElement | null>;
  rootRefExternal?: React.RefObject<HTMLDivElement | null>;
};

const ENTER_DELAY_MS = 16;

export const MobileSessionsSheet = React.memo(function MobileSessionsSheet({
  open,
  onOpenChange,
  variant = 'drawer',
  drawerRefExternal,
  scrimRefExternal,
  rootRefExternal,
}: MobileSessionsSheetProps) {
  const rootRefElement = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => {
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeElement instanceof HTMLElement && rootRefElement.current?.contains(activeElement)) {
      activeElement.blur();
    }
    onOpenChange(false);
  }, [onOpenChange]);
  const [entered, setEntered] = React.useState(false);
  const drawerRefInternal = React.useRef<HTMLDivElement>(null);
  const scrimRefInternal = React.useRef<HTMLButtonElement>(null);
  const drawerRef = (drawerRefExternal ?? drawerRefInternal) as React.RefObject<HTMLDivElement | null>;
  const scrimRef = (scrimRefExternal ?? scrimRefInternal) as React.RefObject<HTMLButtonElement | null>;
  const rootRefForExternal = React.useCallback((node: HTMLDivElement | null) => {
    (rootRefElement as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (rootRefExternal) (rootRefExternal as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [rootRefExternal]);
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Fallback for browsers that do not move focus when the closed drawer
  // becomes inert.
  React.useEffect(() => {
    const root = rootRefElement.current;
    if (!root || open) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && root.contains(active)) active.blur();
  }, [open]);

  React.useEffect(() => {
    if (variant === 'sidebar') return undefined;
    if (open) {
      const id = window.setTimeout(() => setEntered(true), prefersReducedMotion ? 0 : ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    return undefined;
  }, [open, prefersReducedMotion, variant]);

  React.useEffect(() => {
    if (variant === 'sidebar' || !open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close, open, variant]);

  const isTabletSidebar = variant === 'sidebar';
  const sidebar = (
    <SessionSidebar
      mobileVariant={!isTabletSidebar}
      isVisible={open}
      allowReselect
      onSessionSelected={isTabletSidebar ? undefined : close}
      onNavigateAway={isTabletSidebar ? undefined : close}
    />
  );

  useDrawerSwipe({
    side: 'left',
    enabled: variant === 'drawer',
    open,
    drawerRef,
    scrimRef,
    onClose: close,
    widthRatio: 0.72,
    prefersReducedMotion,
  });

  if (variant === 'sidebar') {
    return (
      <aside className="relative flex h-full w-full flex-col bg-sidebar">
        {sidebar}
      </aside>
    );
  }

  if (typeof document === 'undefined') return null;

  const duration = prefersReducedMotion ? 0 : MOBILE_DRAWER_DURATION_MS;

  return createPortal(
    <div
      ref={rootRefForExternal}
      className="fixed inset-0 z-50"
      inert={!open}
      style={{
        pointerEvents: open ? 'auto' : 'none',
      }}
      data-mobile-sessions-root="true"
    >
      <button
        ref={scrimRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="absolute inset-0 cursor-default bg-black/70"
        aria-label="Close sessions"
        onClick={close}
        tabIndex={open ? 0 : -1}
        style={{
          opacity: entered ? 1 : 0,
          transition: `opacity ${duration}ms ${MOBILE_DRAWER_EASING}`,
        }}
        data-mobile-sessions-scrim="true"
      />
      <div
        ref={drawerRef as React.RefObject<HTMLDivElement>}
        className={cn('relative z-10 flex h-full w-[72%] max-w-[72%] flex-col bg-sidebar')}
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          transform: entered ? 'none' : 'translateX(-100%)',
          transition: duration ? `transform ${duration}ms ${MOBILE_DRAWER_EASING}` : 'none',
          touchAction: 'pan-x pan-y',
        }}
        data-mobile-sessions-drawer="true"
      >
        {sidebar}
      </div>
    </div>,
    document.body,
  );
});
