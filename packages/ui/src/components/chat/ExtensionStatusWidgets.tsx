import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDeviceInfo } from '@/lib/device';
import { ExtensionsSurface } from '@/components/chat/extension/ExtensionsSurface';
import { AnsiText } from '@/components/chat/AnsiText';
import { stripAnsi } from '@/lib/pi/ansi';
import type { PiReducerExtensionNotice } from '@/lib/pi/reducers/reducerTypes';
import {
  formatExtensionNoticeTime,
  getExtensionNoticesSeenAt,
  markExtensionNoticesSeen,
  newestExtensionNoticeAt,
  readExtensionNoticesSeen,
  safeRuntimeKeyForNotices,
  selectUnreadExtensionNotices,
  shouldToastExtensionNotice,
} from '@/lib/pi/extensionNotices';
import type { IconName } from '@/components/icon/icons';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from '@/components/chat/changedFilesPopover';
import { cn } from '@/lib/utils';

/**
 * Live pi extension surfaces for the selected session: footer-style status
 * entries (`ctx.ui.setStatus`) and rail navigation chip.
 */

const stripEquality = (a: unknown[], b: unknown[]): boolean => (
  a.length === b.length && a.every((item, index) => item === b[index])
);

interface ExtensionContentCounts {
  widgetsCount: number;
  sessionDirectory?: string;
}

export const ExtensionStatusStrip: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;
  const { isMobile } = useDeviceInfo();
  const [mobileExpanded, setMobileExpanded] = React.useState(false);

  const statuses = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return [...(session?.extensionStatuses.entries() ?? [])];
    },
    (a, b) => stripEquality(a.flat(), b.flat()),
    `session:${activeSessionId ?? ''}`,
  );

  const { widgetsCount, sessionDirectory } = usePiSessionSnapshot<ExtensionContentCounts>(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return {
        widgetsCount: session?.extensionWidgets.size ?? 0,
        sessionDirectory: session?.directory,
      };
    },
    (a, b) =>
      a.widgetsCount === b.widgetsCount &&
      a.sessionDirectory === b.sessionDirectory,
    `session:${activeSessionId ?? ''}`,
  );

  React.useEffect(() => {
    if (widgetsCount === 0) {
      setMobileExpanded(false);
    }
  }, [widgetsCount]);

  // The rail chip counts Pi-native `ctx.ui.setWidget` content only.
  const contentSummary = widgetsCount === 0
    ? ''
    : widgetsCount === 1 ? '1 widget' : `${widgetsCount} widgets`;

  const handleOpenExtensions = React.useCallback(() => {
    if (isMobile) {
      // On mobile runtime, ContextPanel is not rendered so openContextSurface does nothing.
      // Toggle inline ExtensionsSurface below the status pill instead.
      setMobileExpanded((prev) => !prev);
      return;
    }
    const dir = sessionDirectory || useDirectoryStore.getState().currentDirectory || '';
    // Desktop runtime: toggles ContextPanel Extensions surface.
    useUIStore.getState().openContextSurface(dir, 'extensions');
  }, [isMobile, sessionDirectory]);

  // Notices render on their own pill when the strip is otherwise empty.
  if (statuses.length === 0 && !contentSummary) {
    return <ExtensionRecentNotices sessionId={activeSessionId} />;
  }

  return (
    <div className="chat-input-column flex flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-full border border-border/40 bg-card px-3 py-1.5 shadow-sm transition-[opacity,transform] duration-150">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-interactive-hover text-muted-foreground">
            <Icon name="plug-2" className="size-3" />
          </span>
          {statuses.length > 0 && (
            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hidden touch-pan-x" data-no-drawer-swipe="true">
              {statuses.map(([key, text]) => (
                <span
                  key={key}
                  className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 typography-micro font-medium text-foreground"
                >
                  <AnsiText text={text} />
                </span>
              ))}
            </div>
          )}
        </div>
        {contentSummary && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleOpenExtensions}
            aria-label="Open extensions panel"
            aria-expanded={isMobile ? mobileExpanded : undefined}
            className="shrink-0 gap-1 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground active:bg-interactive-active"
          >
            <Icon name="layout-right" className="size-3" />
            <span>{contentSummary}</span>
          </Button>
        )}
      </div>
      {/* Own row below the status pill: the pill clips overflow, so the
        notices popover cannot anchor inside it. */}
      <ExtensionRecentNotices sessionId={activeSessionId} />
      {isMobile && mobileExpanded && (
        <div className="max-h-60 overflow-y-auto rounded-xl border border-border/80 bg-card p-2 shadow-md">
          <ExtensionsSurface sessionId={activeSessionId} className="h-auto" />
        </div>
      )}
    </div>
  );
};

/**
 * IDs of extension notices already surfaced as toasts in this tab.
 *
 * Module scope (not a per-instance ref) is load-bearing: chat branches
 * unmount/remount this component as a session moves between loading, working,
 * and settled-empty views. A notice that arrived while the working branch was
 * mounted must still be "shown" when the settled branch mounts, and a notice
 * that arrived while no branch was mounted must toast on the next mount
 * rather than being seeded away as historical. Reconnect replays can re-toast
 * a recent notice after a reload; that references a real event and is cheaper
 * than swallowing routine command confirmations. Bounded so long-lived tabs
 * cannot grow it without limit.
 */
const shownExtensionNoticeIds = new Set<string>();
const MAX_SHOWN_EXTENSION_NOTICE_IDS = 200;

const markExtensionNoticeShown = (id: string): void => {
  shownExtensionNoticeIds.add(id);
  while (shownExtensionNoticeIds.size > MAX_SHOWN_EXTENSION_NOTICE_IDS) {
    const oldest = shownExtensionNoticeIds.values().next().value;
    if (oldest === undefined) break;
    shownExtensionNoticeIds.delete(oldest);
  }
};

const extensionNoticesEquality = (
  a: PiReducerExtensionNotice[],
  b: PiReducerExtensionNotice[],
): boolean => a.length === b.length && a.every((notice, index) => notice.id === b[index]?.id);

/** Fire-and-forget ctx.ui.notify calls surface as transient toasts.
 *
 * Only live entries toast, and only once per entry: snapshot/detail history
 * never toasts (it is listed under Recent notices instead), and a live
 * server-stamped entry older than the freshness guard is a reconnect replay,
 * not a new notification. A toast shown while the document is focused marks
 * the notice seen; toasts the user never saw stay unread until the list opens.
 */
export const ExtensionNoticeToasts: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const notices = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return session?.extensionNotices ?? [];
    },
    extensionNoticesEquality,
    `session:${activeSessionId ?? ''}`,
  );

  React.useEffect(() => {
    let newestToastedAt = 0;
    for (const notice of notices) {
      if (shownExtensionNoticeIds.has(notice.id)) continue;
      markExtensionNoticeShown(notice.id);
      if (!shouldToastExtensionNotice(notice)) continue;
      const message = stripAnsi(notice.message || 'Extension notification');
      if (notice.level === 'error') toast.error(message);
      else if (notice.level === 'warning') toast.warning(message);
      else toast.info(message);
      if (notice.createdAt > newestToastedAt) newestToastedAt = notice.createdAt;
    }
    if (newestToastedAt > 0 && activeSessionId) {
      const focused = typeof document === 'undefined'
        || (typeof document.hasFocus === 'function' ? document.hasFocus() : true);
      if (focused) markExtensionNoticesSeen(safeRuntimeKeyForNotices(), activeSessionId, newestToastedAt);
    }
  }, [notices, activeSessionId]);

  return null;
};

const EXTENSION_NOTICE_LEVEL_ICON: Record<PiReducerExtensionNotice['level'], IconName> = {
  info: 'information',
  warning: 'alert',
  error: 'error-warning',
};

const EXTENSION_NOTICE_LEVEL_ICON_CLASS: Record<PiReducerExtensionNotice['level'], string> = {
  info: 'text-[var(--status-info)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
};

/**
 * Notice history list, newest first: level icon/color via status tokens,
 * wrapping selectable message text, and a short relative timestamp.
 */
export const ExtensionNoticeList: React.FC<{ notices: readonly PiReducerExtensionNotice[] }> = ({ notices }) => {
  const newestFirst = [...notices].reverse();
  return (
    <ul className="flex flex-col gap-0.5">
      {newestFirst.map((notice) => (
        <li
          key={notice.id}
          className="flex items-start gap-2 rounded-lg px-2 py-1.5"
        >
          <Icon
            name={EXTENSION_NOTICE_LEVEL_ICON[notice.level]}
            className={cn('mt-0.5 size-4 shrink-0', EXTENSION_NOTICE_LEVEL_ICON_CLASS[notice.level])}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="whitespace-pre-wrap break-words text-left typography-ui-label text-foreground select-text">
              <AnsiText text={notice.message} />
            </p>
            <span className="typography-micro text-muted-foreground">
              {formatExtensionNoticeTime(notice.createdAt)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
};

/**
 * "Recent notices" button for the active session's extension status area.
 * Hidden while the session has no notices. The unread dot marks notices
 * newer than this device's last-seen marker; opening the list marks every
 * current notice seen. Same component on mobile and desktop.
 */
export const ExtensionRecentNotices: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;
  const runtimeKey = safeRuntimeKeyForNotices();

  const notices = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return session?.extensionNotices ?? [];
    },
    extensionNoticesEquality,
    `session:${activeSessionId ?? ''}`,
  );

  const [open, setOpen] = React.useState(false);
  const [seenAt, setSeenAt] = React.useState<number | undefined>(() => (
    activeSessionId
      ? getExtensionNoticesSeenAt(readExtensionNoticesSeen(), runtimeKey, activeSessionId)
      : undefined
  ));
  const popoverRef = React.useRef<HTMLDivElement>(null);

  // A toast shown while focused marks itself seen without opening the list;
  // re-read the marker when the list changes so the dot clears promptly.
  React.useEffect(() => {
    if (!activeSessionId) return;
    setSeenAt(getExtensionNoticesSeenAt(readExtensionNoticesSeen(), runtimeKey, activeSessionId));
  }, [notices, runtimeKey, activeSessionId]);

  React.useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const unread = activeSessionId ? selectUnreadExtensionNotices(notices, seenAt) : [];
  const unreadCount = unread.length;
  const triggerLabel = unreadCount === 0
    ? 'Recent notices'
    : `Recent notices, ${unreadCount} unread`;

  const handleToggle = React.useCallback(() => {
    if (!open && activeSessionId) {
      const newest = newestExtensionNoticeAt(notices);
      if (newest !== undefined) {
        markExtensionNoticesSeen(runtimeKey, activeSessionId, newest);
        setSeenAt(newest);
      }
    }
    setOpen(!open);
  }, [open, notices, runtimeKey, activeSessionId]);

  if (!activeSessionId || notices.length === 0) return null;

  return (
    <div className="relative" ref={popoverRef}>
      <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-full border border-border/40 bg-card px-3 py-1.5 shadow-sm transition-[opacity,transform] duration-150">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-interactive-hover text-muted-foreground">
            <Icon name="notification-3" className="size-3" />
          </span>
          <span className="min-w-0 flex-1 truncate typography-micro font-medium text-muted-foreground">
            Recent notices
          </span>
        </div>
        <div className="relative shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleToggle}
            aria-label={triggerLabel}
            title={triggerLabel}
            aria-expanded={open}
            className="shrink-0 gap-1 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground active:bg-interactive-active"
          >
            <Icon name="notification-3" className="size-3" />
            <span>{notices.length === 1 ? '1 notice' : `${notices.length} notices`}</span>
          </Button>
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--status-info)]"
            />
          )}
        </div>
      </div>
      {open && (
        <div
          role="dialog"
          aria-label="Recent notices"
          style={changedFilesPopoverStyle}
          className={cn(
            changedFilesPopoverClassName,
            'absolute bottom-full right-0 z-50 mb-1 max-h-80 w-80 overflow-y-auto',
          )}
        >
          <ExtensionNoticeList notices={notices} />
        </div>
      )}
    </div>
  );
};
