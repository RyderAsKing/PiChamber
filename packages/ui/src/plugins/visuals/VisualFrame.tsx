import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { openChatLink } from '@/components/chat/openRequestActions';
import { copyTextToClipboard } from '@/lib/clipboard';
import { saveOrShareFile } from '@/lib/nativeFileSave';
import { cn } from '@/lib/utils';
import {
  VISUAL_MESSAGE_KEY,
  canOpenLink,
  visualFileName,
  type VisualDetails,
} from './document';
import { useNearViewport, usePageDocument } from './frameHooks';

/** Inline frames fit their page up to this height, then scroll. */
const INLINE_MAX_HEIGHT = 560;
const MIN_HEIGHT = 80;
const PLACEHOLDER_HEIGHT = 240;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface VisualFrameProps {
  details: VisualDetails;
  allowNetwork: boolean;
}

/**
 * One sandboxed page. Listens for its own frame's height and link messages
 * only (`event.source` must be this frame's window).
 */
export function PageFrame({
  title,
  srcDoc,
  className,
  style,
  onHeight,
}: {
  title: string;
  srcDoc: string;
  className?: string;
  style?: React.CSSProperties;
  onHeight?: (height: number) => void;
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const onHeightRef = React.useRef(onHeight);
  onHeightRef.current = onHeight;

  React.useEffect(() => {
    let lastOpenAt = 0;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object' || data[VISUAL_MESSAGE_KEY] !== true) return;
      if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        onHeightRef.current?.(data.height);
        return;
      }
      if (data.type === 'open' && typeof data.url === 'string') {
        // Only right after a click in this frame, and at most once a second:
        // the page cannot open windows on its own.
        const now = Date.now();
        const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (!canOpenLink({
          frameFocused: frame.ownerDocument.activeElement === frame,
          userActive: activation?.isActive,
          now,
          lastOpenAt,
        })) return;
        lastOpenAt = now;
        if (/^https?:\/\//i.test(data.url)) openChatLink(data.url);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={cn('block w-full border-0 bg-transparent', className)}
      style={style}
    />
  );
}

export type FrameView = 'page' | 'code';

function ViewSwitch({ view, onChange }: { view: FrameView; onChange: (view: FrameView) => void }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="View">
      <Button variant="chip" size="xs" aria-pressed={view === 'page'} onClick={() => onChange('page')}>
        {'Page'}
      </Button>
      <Button variant="chip" size="xs" aria-pressed={view === 'code'} onClick={() => onChange('code')}>
        {'Code'}
      </Button>
    </div>
  );
}

function FrameActions({
  details,
  onExpand,
}: {
  details: VisualDetails;
  onExpand?: () => void;
}) {
  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(details.html);
    if (result.ok) toast.success('Copied HTML');
    else toast.error('Could not copy the HTML');
  }, [details.html]);

  const handleDownload = React.useCallback(() => {
    saveOrShareFile({
      filename: visualFileName(details.title),
      mimeType: 'text/html;charset=utf-8',
      data: details.html,
    }).catch(() => toast.error('Could not save the page'));
  }, [details.html, details.title]);

  // In a narrow header (phones, a narrow panel) Copy and Download move into
  // one menu, so the title keeps its room.
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="xs" className="hidden text-muted-foreground @md:inline-flex" onClick={handleCopy} aria-label="Copy HTML" title="Copy HTML">
        <Icon name="file-copy" className="size-3.5" />
      </Button>
      <Button variant="ghost" size="xs" className="hidden text-muted-foreground @md:inline-flex" onClick={handleDownload} aria-label="Download page" title="Download">
        <Icon name="download" className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground @md:hidden" aria-label="More page actions">
            <Icon name="more-fill" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onSelect={() => void handleCopy()}>{'Copy HTML'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDownload}>{'Download page'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {onExpand ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onExpand} aria-label="Expand page" title="Expand">
          <Icon name="fullscreen" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/** The page's HTML, as written. */
function PageCode({ html, className, style }: { html: string; className?: string; style?: React.CSSProperties }) {
  return (
    <pre
      className={cn('m-0 overflow-auto whitespace-pre p-4 font-mono typography-code text-foreground', className)}
      style={style}
      tabIndex={0}
      aria-label="Page HTML"
    >
      {html}
    </pre>
  );
}

/** A page in a full-window dialog, with the Page/Code switch and its actions. */
export function VisualExpandDialog({
  details,
  srcDoc,
  open,
  onOpenChange,
  view,
  onViewChange,
}: {
  details: VisualDetails;
  srcDoc: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: FrameView;
  onViewChange: (view: FrameView) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[calc(100dvh-2rem)] w-[min(1200px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden bg-background p-0"
      >
        <div className="@container flex h-11 shrink-0 items-center gap-2 border-b border-border/60 pl-4 pr-2">
          <DialogTitle className="min-w-0 flex-1 truncate typography-ui-header font-medium leading-normal">
            {details.title}
          </DialogTitle>
          <ViewSwitch view={view} onChange={onViewChange} />
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          <FrameActions details={details} />
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => onOpenChange(false)} aria-label="Close" title="Close">
            <Icon name="close" className="size-3.5" />
          </Button>
        </div>
        {!open ? null : view === 'code' ? (
          <PageCode html={details.html} className="min-h-0 flex-1" />
        ) : (
          <PageFrame title={details.title} srcDoc={srcDoc} className="min-h-0 flex-1" />
        )}
      </DialogContent>
    </Dialog>
  );
}

const FIGURE_CLASS = 'my-3 overflow-hidden rounded-xl border border-border/60 bg-background';
const HEADER_CLASS = '@container flex h-10 items-center gap-2 border-b border-border/60 pl-3.5 pr-1.5';

/** A `render_html` call still being written: its title and how much page so far. */
export function VisualDrawing({ title, size, label = 'Drawing page' }: { title?: string; size: number; label?: string }) {
  return (
    <figure className={FIGURE_CLASS} data-plugin-artifact="visuals" aria-busy="true">
      <figcaption className={HEADER_CLASS}>
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
          {title?.trim() || 'New page'}
        </span>
      </figcaption>
      <div className="flex h-40 flex-col items-center justify-center gap-1.5 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 typography-meta">
          <Icon name="loader-4" aria-hidden="true" className="size-3.5 animate-spin" />
          {label}
        </span>
        {size > 0 ? (
          <span className="typography-micro tabular-nums text-subtle-foreground">
            {size < 1024 ? `${size} characters` : `${Math.round(size / 1024)} KB written`}
          </span>
        ) : null}
      </div>
    </figure>
  );
}

/**
 * A page the agent drew with `render_html`, shown under the turn's activity
 * so it stays in view after the activity collapses.
 */
export function VisualFrame({ details, allowNetwork }: VisualFrameProps) {
  const srcDoc = usePageDocument(details.html, allowNetwork);
  const fixedHeight = details.height !== undefined ? clamp(details.height, 120, 2000) : null;
  const [fittedHeight, setFittedHeight] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [view, setView] = React.useState<FrameView>('page');
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mounted = useNearViewport(hostRef);

  const handleHeight = React.useCallback((height: number) => {
    setFittedHeight(clamp(height, MIN_HEIGHT, INLINE_MAX_HEIGHT));
  }, []);

  const height = fixedHeight ?? fittedHeight ?? PLACEHOLDER_HEIGHT;

  return (
    <figure className={FIGURE_CLASS} data-plugin-artifact="visuals">
      <figcaption className={HEADER_CLASS}>
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" title={details.title}>
          {details.title}
        </span>
        <ViewSwitch view={view} onChange={setView} />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
        <FrameActions details={details} onExpand={() => setExpanded(true)} />
      </figcaption>
      <div ref={hostRef} style={{ height }}>
        {view === 'code' ? (
          <PageCode html={details.html} style={{ height }} />
        ) : mounted ? (
          <PageFrame
            title={details.title}
            srcDoc={srcDoc}
            style={{ height }}
            onHeight={fixedHeight === null ? handleHeight : undefined}
          />
        ) : null}
      </div>

      <VisualExpandDialog
        details={details}
        srcDoc={srcDoc}
        open={expanded}
        onOpenChange={setExpanded}
        view={view}
        onViewChange={setView}
      />
    </figure>
  );
}
