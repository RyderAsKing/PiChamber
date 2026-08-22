import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';

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
      <Icon name="plug" className="size-3.5" />
      {statuses.map(([key, text]) => (
        <span key={key} className="truncate">
          {text}
        </span>
      ))}
    </div>
  );
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
