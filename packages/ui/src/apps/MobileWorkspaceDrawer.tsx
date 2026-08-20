import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TerminalView } from '@/components/views/TerminalView';
import { cn } from '@/lib/utils';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';

const DRAWER_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export type MobileWorkspaceTab = 'changes' | 'files' | 'terminal' | 'notes';

const WORKSPACE_TABS: Array<{
  id: MobileWorkspaceTab;
  label: string;
  icon: 'git-branch' | 'file-text' | 'terminal' | 'sticky-note';
}> = [
  { id: 'changes', label: 'Changes', icon: 'git-branch' },
  { id: 'files', label: 'Files', icon: 'file-text' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'notes', label: 'Notes', icon: 'sticky-note' },
];

/** The workspace surfaces as tabs (Changes / Files / Terminal / Notes).

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
export const MobileWorkspaceDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  tab: MobileWorkspaceTab;
  onTabChange: (tab: MobileWorkspaceTab) => void;
  /** When set, the Changes tab opens directly into the per-file diff. */
  pendingChangesDiff: { path: string; staged: boolean } | null;
  variant?: 'drawer' | 'panel';
}> = ({ open, onClose, tab, onTabChange, pendingChangesDiff, variant = 'drawer' }) => {
  
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const tabRef = React.useRef(tab);
  React.useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
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
    const id = window.setTimeout(() => setVisible(false), ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open, prefersReducedMotion]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    if (variant === 'drawer') document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && tabRef.current !== 'terminal') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (variant === 'drawer') document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, variant]);

  if (variant === 'drawer' && !rootRef.current) return null;

  const duration = prefersReducedMotion ? 0 : ENTER_DURATION_MS;

  const tabs = (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Workspace">
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
            <Icon name={item.icon} className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  const body = (
    <>
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-2">
        {tabs}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workspace panel"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {visitedTabs.has('changes') ? (
          <div
            key={pendingChangesDiff ? `changes:${pendingChangesDiff.path}:${pendingChangesDiff.staged}` : 'changes'}
            className={cn('h-full', tab !== 'changes' && 'hidden')}
          >
            <ErrorBoundary>
              <MobileChangesSurface
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {visitedTabs.has('files') ? (
          <div className={cn('h-full', tab !== 'files' && 'hidden')}>
            <ErrorBoundary>
              <MobileFilesSurface />
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
        {visitedTabs.has('notes') ? (
          <div className={cn('h-full', tab !== 'notes' && 'hidden')}>
            <ErrorBoundary>
              <ProjectContextPanel onActionComplete={onClose} />
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
      className="fixed inset-0 z-50"
      aria-hidden={!open}
      style={{
        pointerEvents: open ? 'auto' : 'none',
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/70"
        aria-label="Close workspace panel"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        style={{
          opacity: entered ? 1 : 0,
          transition: duration ? `opacity ${duration}ms ${DRAWER_EASING}` : 'none',
        }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={"Open workspace panel"}
        className="oc-keyboard-inset-surface absolute inset-y-0 right-0 z-10 flex h-full w-full flex-col bg-sidebar"
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          transform: entered ? 'none' : 'translateX(100%)',
          transition: duration ? `transform ${duration}ms ${DRAWER_EASING}` : 'none',
        }}
      >
        {body}
      </section>
    </div>,
    rootRef.current as HTMLElement,
  );
};
