import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

const humanizeKey = (key: string): string => {
  const words = key.replace(/[-_]+/g, ' ').trim();
  if (!words) return key;
  return words.replace(/\b\w/g, (char) => char.toUpperCase());
};

export interface ExtensionsSurfaceProps {
  sessionId?: string | null;
  className?: string;
}

export const ExtensionsSurface: React.FC<ExtensionsSurfaceProps> = ({ sessionId, className }) => {
  const { t } = useTranslation();
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  // Pi-native `ctx.ui.setWidget` content only. Statuses belong to the composer
  // strip; PiChamber-only panels/apps are intentionally not rendered here yet.
  // The reducer replaces the widget map copy-on-write, so reference equality
  // is exact and stays cheap while unrelated session state streams.
  const widgetMap = usePiSessionSnapshot(
    (state) => (activeSessionId ? state.reducer.bySession.get(activeSessionId)?.extensionWidgets : undefined),
    (a, b) => a === b,
    activeSessionId ? `session:${activeSessionId}` : 'chrome',
  );
  const widgets = React.useMemo(() => [...(widgetMap?.entries() ?? [])], [widgetMap]);

  const [collapsedWidgets, setCollapsedWidgets] = React.useState<Record<string, boolean>>({});

  const toggleWidget = React.useCallback((key: string) => {
    setCollapsedWidgets((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (widgets.length === 0) {
    return (
      <div
        className={cn('flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center', className)}
        data-testid="extensions-surface-empty"
      >
        <Icon name="plug-2" aria-hidden="true" className="size-6 text-muted-foreground/60" />
        <p className="typography-ui-label font-medium text-foreground">{t('No extension widgets yet')}</p>
        <p className="max-w-60 typography-micro text-muted-foreground">
          {t('Widgets that extensions set with ctx.ui.setWidget show up here.')}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col overflow-y-auto', className)}
      data-testid="extensions-surface"
    >
      <SurfaceSection title={t('Widgets')} count={widgets.length}>
        {widgets.map(([key, widget]) => (
          <CollapsibleRow
            key={key}
            title={humanizeKey(key)}
            meta={widget.placement === 'belowEditor' ? t('below editor') : t('above editor')}
            collapsed={Boolean(collapsedWidgets[key])}
            onToggle={() => toggleWidget(key)}
            testId={`extension-widget-${key}`}
          >
            <div className="max-h-64 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono typography-micro leading-relaxed text-foreground">
              {widget.lines.map((line, index) => (
                <span key={index} className="block whitespace-pre-wrap">
                  <AnsiText text={line} />
                </span>
              ))}
            </div>
          </CollapsibleRow>
        ))}
      </SurfaceSection>
    </div>
  );
};

/** Flat labelled section, matching the GitHub list sections in the rail. */
const SurfaceSection: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children,
}) => (
  <section aria-label={title} className="border-t border-border/60 first:border-t-0">
    <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 typography-micro font-medium text-muted-foreground">
      {title}
      <span className="tabular-nums text-muted-foreground/70">{count}</span>
    </p>
    <div className="flex flex-col p-1 pt-0.5">{children}</div>
  </section>
);

/** Rail row with a chevron glyph column; the body indents under the title. */
const CollapsibleRow: React.FC<{
  title: string;
  meta?: string;
  collapsed: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}> = ({ title, meta, collapsed, onToggle, testId, children }) => (
  <div data-testid={testId}>
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-interactive-hover"
    >
      <span className="inline-flex w-4 shrink-0 items-center justify-center">
        <Icon
          name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
      </span>
      <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={title}>
        {title}
      </span>
      {meta ? (
        <span className="shrink-0 whitespace-nowrap typography-micro text-muted-foreground">{meta}</span>
      ) : null}
    </button>
    {!collapsed && <div className="pb-2 pl-8 pr-2 pt-0.5">{children}</div>}
  </div>
);
