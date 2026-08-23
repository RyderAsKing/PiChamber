import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';

/**
 * Live pi extension surfaces for the selected session: footer-style status
 * entries (`ctx.ui.setStatus`) and editor widgets (`ctx.ui.setWidget` lines).
 */

const stripEquality = (a: unknown[], b: unknown[]): boolean => (
  a.length === b.length && a.every((item, index) => item === b[index])
);

export const ExtensionStatusStrip: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const statuses = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return [...(session?.extensionStatuses.entries() ?? [])];
    },
    (a, b) => stripEquality(a.flat(), b.flat()),
    `session:${activeSessionId ?? ''}`,
  );

  if (statuses.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-0.5 text-xs text-muted-foreground">
      <Icon name="plug-2" className="size-3.5" />
      {statuses.map(([key, text]) => (
        <span key={key} className="truncate">
          {text}
        </span>
      ))}
    </div>
  );
};

/** Fire-and-forget ctx.ui.notify calls surface as transient toasts. */
export const ExtensionNoticeToasts: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const notices = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return session?.extensionNotices ?? [];
    },
    (a, b) => a.length === b.length && a.every((notice, index) => notice.id === b[index]?.id),
    `session:${activeSessionId ?? ''}`,
  );

  const shownIds = React.useRef<Set<string>>(new Set());

  // Seed the ref with what is already present on first sight of a session so
  // reconnect replays do not re-toast historical notices.
  if (shownIds.current.size === 0) {
    for (const notice of notices) shownIds.current.add(notice.id);
  }

  React.useEffect(() => {
    for (const notice of notices) {
      if (shownIds.current.has(notice.id)) continue;
      shownIds.current.add(notice.id);
      const message = notice.message || 'Extension notification';
      if (notice.level === 'error') toast.error(message);
      else if (notice.level === 'warning') toast.warning(message);
      else toast.info(message);
    }
  }, [notices]);

  return null;
};

export const ExtensionWidgetStrip: React.FC<{
  sessionId?: string | null;
  placement?: 'aboveEditor' | 'belowEditor';
  className?: string;
}> = ({ sessionId, placement = 'aboveEditor', className }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const widgets = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return [...(session?.extensionWidgets.entries() ?? [])].filter(([, widget]) => widget.placement === placement);
    },
    (a, b) => stripEquality(a.map(([key, widget]) => `${key}:${widget.lines.join('\n')}`), b.map(([key, widget]) => `${key}:${widget.lines.join('\n')}`)),
    `session:${activeSessionId ?? ''}`,
  );

  if (widgets.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-dashed px-3 py-2',
        placement === 'belowEditor' ? 'mt-2' : 'mb-2',
        className,
      )}
    >
      {widgets.map(([key, widget]) => (
        <div key={key} className="flex flex-col gap-0.5 font-mono text-xs leading-relaxed text-muted-foreground">
          {widget.lines.map((line, index) => (
            <span key={index} className="whitespace-pre-wrap">{line}</span>
          ))}
        </div>
      ))}
    </div>
  );
};
