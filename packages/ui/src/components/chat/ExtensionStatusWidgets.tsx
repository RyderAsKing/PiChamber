import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { cn } from '@/lib/utils';
import { containsAnsiEscape, extractAnsiTruecolor, stripAnsi } from '@/lib/pi/ansi';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';

/**
 * Live pi extension surfaces for the selected session: footer-style status
 * entries (`ctx.ui.setStatus`) and editor widgets (`ctx.ui.setWidget` lines).
 */

const stripEquality = (a: unknown[], b: unknown[]): boolean => (
  a.length === b.length && a.every((item, index) => item === b[index])
);

// Pi TUI extensions color status text with raw ANSI (dotfiles `modes.ts`
// uses 24-bit sequences for per-mode colors, `token-speed.ts` uses
// `ctx.ui.theme.fg`). Strip the escapes and, when a truecolor is present,
// preserve it as CSS so mode identity survives on the web surface.
function renderStatusText(text: string): React.ReactNode {
  // Fast path: no ESC at all
  if (!containsAnsiEscape(text)) return text;
  const clean = stripAnsi(text);
  const color = extractAnsiTruecolor(text);
  if (!color) return clean;
  // Keep the whole segment in the mode color; the surrounding pill already
  // provides muted background/border so colored text is enough to recover
  // the per-mode identity from the TUI without a full ANSI parser.
  return <span style={{ color }}>{clean}</span>;
}

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
    <div className="chat-input-column">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-full border border-border/40 bg-card px-3 py-1.5 shadow-sm transition-[opacity,transform] duration-150">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-interactive-hover text-muted-foreground">
          <Icon name="plug-2" className="size-3" />
        </span>
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hidden touch-pan-x" data-no-drawer-swipe="true">
          {statuses.map(([key, text]) => {
            const color = extractAnsiTruecolor(text);
            return (
              <span
                key={key}
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 typography-micro font-medium"
                style={
                  color
                    ? {
                        color,
                        borderColor: `color-mix(in srgb, ${color} 28%, var(--border))`,
                        background: `color-mix(in srgb, ${color} 12%, var(--muted))`,
                      }
                    : undefined
                }
              >
                <span className={cn(!color && "text-muted-foreground")}>
                  {renderStatusText(text)}
                </span>
              </span>
            );
          })}
        </div>
      </div>
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
      const message = stripAnsi(notice.message || 'Extension notification');
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
    <div className={cn('chat-input-column', className)}>
      <div className="rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-[opacity,transform] duration-150">
        <div className="mb-2 flex items-center gap-1.5 border-b border-border/40 pb-2">
          <Icon name="plug-2" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
            Extensions
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {widgets.map(([key, widget]) => (
            <div
              key={key}
              className="rounded-lg border border-border/30 bg-muted/40 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground"
            >
              {widget.lines.map((line, index) => (
                <span key={index} className="block whitespace-pre-wrap">
                  {containsAnsiEscape(line) ? stripAnsi(line) : line}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
