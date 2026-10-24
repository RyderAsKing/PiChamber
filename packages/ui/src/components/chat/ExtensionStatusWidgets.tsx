import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDeviceInfo } from '@/lib/device';
import { ExtensionsSurface } from '@/components/chat/extension/ExtensionsSurface';
import { AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';

/**
 * Live pi extension footer surface for the selected session: status entries
 * (`ctx.ui.setStatus`) and the rail navigation chip for widget content.
 *
 * Fire-and-forget extension notices (`ctx.ui.notify`) are not toasted here;
 * they render as inline transcript rows (see the notice overlay applied in
 * MessageList and ExtensionNoticeRow).
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

  if (statuses.length === 0 && !contentSummary) return null;

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
      {isMobile && mobileExpanded && (
        <div className="max-h-60 overflow-y-auto rounded-xl border border-border/80 bg-card p-2 shadow-md">
          <ExtensionsSurface sessionId={activeSessionId} className="h-auto" />
        </div>
      )}
    </div>
  );
};
