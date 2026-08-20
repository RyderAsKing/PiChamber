import React from 'react';
import { createPortal } from 'react-dom';

import { SessionSidebar } from '@/components/session/SessionSidebar';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { MOBILE_DRAWER_DURATION_MS, MOBILE_DRAWER_EASING, useDrawerSwipe } from './useDrawerSwipe';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' renders a 72%-width overlay; 'sidebar' is the tablet persistent pane. */
  variant?: 'drawer' | 'sidebar';
};

const ENTER_DELAY_MS = 16;

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({
  open,
  onOpenChange,
  variant = 'drawer',
}) => {
  const rootRefElement = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => {
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeElement instanceof HTMLElement && rootRefElement.current?.contains(activeElement)) {
      activeElement.blur();
    }
    onOpenChange(false);
  }, [onOpenChange]);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const [entered, setEntered] = React.useState(false);
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const scrimRef = React.useRef<HTMLButtonElement>(null);
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

  const handleNewSession = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    openNewSessionDraft();
    close();
  }, [close, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

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
      ref={rootRefElement}
      className="fixed inset-0 z-50"
      inert={!open}
      style={{
        pointerEvents: open ? 'auto' : 'none',
      }}
      data-mobile-sessions-root="true"
    >
      <button
        ref={scrimRef}
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
        ref={drawerRef}
        className={cn('relative z-10 flex h-full w-[72%] max-w-[72%] flex-col bg-sidebar')}
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          transform: entered ? 'none' : 'translateX(-100%)',
          transition: duration ? `transform ${duration}ms ${MOBILE_DRAWER_EASING}` : 'none',
          touchAction: 'pan-y',
        }}
        data-mobile-sessions-drawer="true"
      >
        {sidebar}
      </div>
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-[28%] items-end justify-center"
        style={{ paddingBottom: 'calc(1rem + var(--oc-safe-area-bottom, 0px))' }}
      >
        {open ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="pointer-events-auto size-12 rounded-full p-0 [corner-shape:round] supports-[corner-shape:squircle]:rounded-full"
            onClick={handleNewSession}
            aria-label="New session"
          >
            <Icon name="chat-new" className="size-5" />
          </Button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};
