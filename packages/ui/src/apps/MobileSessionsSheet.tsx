import React from 'react';
import { createPortal } from 'react-dom';

import { SessionSidebar } from '@/components/session/SessionSidebar';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' renders a 72%-width overlay; 'sidebar' is the tablet persistent pane. */
  variant?: 'drawer' | 'sidebar';
};

const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({
  open,
  onOpenChange,
  variant = 'drawer',
}) => {
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const [entered, setEntered] = React.useState(false);
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

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

  const sidebar = (
    <SessionSidebar
      mobileVariant
      isVisible
      allowReselect
      onSessionSelected={close}
      onNavigateAway={close}
    />
  );

  if (variant === 'sidebar') {
    return (
      <aside className="relative flex h-full w-full flex-col bg-sidebar">
        {sidebar}
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="absolute z-20 size-12 rounded-full p-0 [corner-shape:round] supports-[corner-shape:squircle]:rounded-full"
          style={{
            right: '1rem',
            bottom: 'calc(1rem + var(--oc-safe-area-bottom, 0px))',
          }}
          onClick={handleNewSession}
          aria-label="New session"
        >
          <Icon name="chat-new" className="size-5" />
        </Button>
      </aside>
    );
  }

  if (typeof document === 'undefined') return null;

  const duration = prefersReducedMotion ? 0 : ENTER_DURATION_MS;

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      aria-hidden={!open}
      style={{
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/70"
        aria-label="Close sessions"
        onClick={close}
        tabIndex={open ? 0 : -1}
        style={{
          opacity: entered ? 1 : 0,
          transition: `opacity ${duration}ms ${DRAWER_EASING}`,
        }}
      />
      <div
        className={cn('relative z-10 flex h-full w-[72%] max-w-[72%] flex-col bg-sidebar')}
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          transform: entered ? 'none' : 'translateX(-100%)',
          transition: duration ? `transform ${duration}ms ${DRAWER_EASING}` : 'none',
        }}
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
