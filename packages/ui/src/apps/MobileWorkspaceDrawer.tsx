import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TerminalView } from '@/components/views/TerminalView';
import { cn } from '@/lib/utils';
import { MOBILE_DRAWER_DURATION_MS, MOBILE_DRAWER_EASING, useDrawerSwipe } from './useDrawerSwipe';

const LazyFilesView = React.lazy(() =>
  import('@/components/views/FilesView').then((module) => ({ default: module.FilesView })),
);
const LazyGitView = React.lazy(() =>
  import('@/components/views/GitView').then((module) => ({ default: module.GitView })),
);

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;

export type MobileWorkspaceTab = 'changes' | 'files' | 'terminal';

const WORKSPACE_TABS: Array<{
  id: MobileWorkspaceTab;
  label: string;
  icon: 'git-branch' | 'file-text' | 'terminal';
}> = [
  { id: 'changes', label: 'Changes', icon: 'git-branch' },
  { id: 'files', label: 'Files', icon: 'file-text' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
];

/** The workspace surfaces as tabs (Changes / Files / Terminal).

    Two hosts, same content and same state:
     - `drawer` (default) covers 80% from the right with a dark scrim — matching
       the sessions drawer — on the phone, and a tablet in portrait where a side
       panel would leave no usable chat column;
     - `panel` renders inline so the caller can size it as a real sidebar
       beside the chat (tablet, landscape). The caller owns the width and the
       open/close animation there; this component only fills it.

    The phone drawer closes via the remaining 20% scrim, Escape (unless the
    terminal tab owns the keys), or the Android back button (handled by
    MobileShell). */
export const MobileWorkspaceDrawer = React.memo(function MobileWorkspaceDrawer({
  open,
  onClose,
  tab,
  onTabChange,
  pendingChangesDiff,
  variant = 'drawer',
  drawerRefExternal,
  scrimRefExternal,
  rootRefExternal,
}: {
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  /** When set, the Changes tab opens directly into the per-file diff. */
  pendingChangesDiff: { path: string; staged: boolean } | null;
  variant?: 'drawer' | 'panel';
  drawerRefExternal?: React.RefObject<HTMLElement | null>;
  scrimRefExternal?: React.RefObject<HTMLButtonElement | null>;
  rootRefExternal?: React.RefObject<HTMLDivElement | null>;
}) {
  const rootRef = React.useRef<HTMLElement | null>(null);
  const drawerRefInternal = React.useRef<HTMLElement>(null);
  const scrimRefInternal = React.useRef<HTMLButtonElement>(null);
  const rootElementRefInternal = React.useRef<HTMLDivElement>(null);
  const drawerRef = (drawerRefExternal ?? drawerRefInternal) as React.RefObject<HTMLElement | null>;
  const scrimRef = (scrimRefExternal ?? scrimRefInternal) as React.RefObject<HTMLButtonElement | null>;
  const rootElementRef = (rootRefExternal ?? rootElementRefInternal) as React.RefObject<HTMLDivElement | null>;
  const setRootElementRef = React.useCallback((node: HTMLDivElement | null) => {
    (rootElementRefInternal as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (rootRefExternal) (rootRefExternal as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [rootRefExternal]);
  const handleClose = React.useCallback(() => {
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeElement instanceof HTMLElement && rootElementRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
    onClose();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);
  const [entered, setEntered] = React.useState(false);
  const [visible, setVisible] = React.useState(open);
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<MobileWorkspaceTab>>(() => new Set());
  React.useEffect(() => {
    if (!open) return;
    setVisitedTabs((current) => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  }, [open, tab]);

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      const id = window.setTimeout(() => setEntered(true), prefersReducedMotion ? 0 : ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), MOBILE_DRAWER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open, prefersReducedMotion]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    if (variant === 'drawer') document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && tab !== 'terminal') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (variant === 'drawer') document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClose, open, tab, variant]);

  // Fallback for browsers that do not move focus when the closed drawer
  // becomes inert.
  React.useEffect(() => {
    const root = rootElementRef.current;
    if (!root || open || variant !== 'drawer') return;
    const active = document.activeElement as HTMLElement | null;
    if (active && root.contains(active)) active.blur();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant]);

  useDrawerSwipe({
    side: 'right',
    enabled: variant === 'drawer',
    open,
    drawerRef,
    scrimRef,
    onClose: handleClose,
    widthRatio: 1,
    prefersReducedMotion,
  });

  if (variant === 'drawer' && !rootRef.current) return null;

  const duration = prefersReducedMotion ? 0 : MOBILE_DRAWER_DURATION_MS;

  const tabs = (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Workspace" data-no-drawer-swipe="true">
      {WORKSPACE_TABS.map((item) => {
        const isActive = tab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(item.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-2 typography-ui-label transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              isActive
                ? 'bg-interactive-selection text-foreground'
                : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
            )}
          >
            <Icon name={item.icon} className="size-5 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  const body = (
    <>
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-1 px-2">
        {tabs}
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close workspace panel"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name="close" className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {visitedTabs.has('changes') ? (
          <div
            key={pendingChangesDiff ? `changes:${pendingChangesDiff.path}:${pendingChangesDiff.staged}` : 'changes'}
            className={cn('h-full', tab !== 'changes' && 'hidden')}
          >
            <ErrorBoundary>
              <React.Suspense fallback={null}>
                <LazyGitView
                  isActive={open && tab === 'changes'}
                  chrome="mobile"
                  initialDiffPath={pendingChangesDiff?.path ?? null}
                  initialDiffStaged={pendingChangesDiff?.staged === true}
                />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('files') ? (
          <div className={cn('h-full', tab !== 'files' && 'hidden')}>
            <ErrorBoundary>
              <React.Suspense fallback={null}>
                <LazyFilesView chrome="mobile" mode="editor-only" />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('terminal') ? (
          <div className={cn('h-full', tab !== 'terminal' && 'hidden')}>
            <ErrorBoundary>
              <TerminalView visible={open && tab === 'terminal'} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>
    </>
  );

  if (variant === 'panel') {
    return <div className="flex h-full min-h-0 flex-col bg-sidebar">{body}</div>;
  }

  return createPortal(
    <div
      ref={setRootElementRef}
      className="fixed inset-0 z-50"
      inert={!open}
      style={{
        pointerEvents: open ? 'auto' : 'none',
        visibility: visible ? 'visible' : 'hidden',
      }}
      data-mobile-workspace-root="true"
    >
      <button
        ref={scrimRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="absolute inset-0 cursor-default bg-black/70"
        aria-label="Close workspace panel"
        onClick={handleClose}
        tabIndex={open ? 0 : -1}
        style={{
          opacity: entered ? 1 : 0,
          transition: duration ? `opacity ${duration}ms ${MOBILE_DRAWER_EASING}` : 'none',
        }}
        data-mobile-workspace-scrim="true"
      />
      <section
        ref={drawerRef as unknown as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-label={"Open workspace panel"}
        className="oc-keyboard-inset-surface absolute inset-y-0 right-0 z-10 flex h-full w-full flex-col bg-sidebar"
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          transform: entered ? 'none' : 'translateX(100%)',
          transition: duration ? `transform ${duration}ms ${MOBILE_DRAWER_EASING}` : 'none',
          touchAction: 'pan-x pan-y',
        }}
        data-mobile-workspace-drawer="true"
      >
        {body}
      </section>
    </div>,
    rootRef.current as HTMLElement,
  );
});
