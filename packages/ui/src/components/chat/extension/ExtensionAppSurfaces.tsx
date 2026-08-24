import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { normalizeExtensionCommandArgs } from '@/lib/pi/extension-ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

/**
 * Sandboxed extension app surfaces (`pichamber.app` entries).
 *
 * Security model (v1):
 * - The extension-provided HTML renders in an iframe sandboxed with
 *   `allow-scripts` only: no same-origin access, no cookies, no storage, no
 *   top-level navigation, no parent DOM access.
 * - The only capability granted back is invoking slash commands. The parent
 *   injects a per-mount random token into the document; a click on an
 *   element carrying `data-pichamber-command` posts that token back, and the
 *   parent validates token + command shape before prompting the session.
 * - Commands follow the exact same allowlist rules as card actions (no `/`,
 *   no leading `.`), so the browser never executes extension logic — it
 *   executes descriptors.
 */

const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_APP_HEIGHT_PX = 420;

const BRIDGE_SCRIPT_TEMPLATE = [
  '<script>(function(){',
  "var TOKEN=__PICHAMBER_TOKEN__;var APP_ID=__PICHAMBER_APP_ID__;",
  "function closest(start){while(start&&start!==document.documentElement){if(start.hasAttribute&&start.hasAttribute('data-pichamber-command'))return start;start=start.parentNode;}return null;}",
  "document.addEventListener('click',function(ev){",
  "var el=closest(ev.target);if(!el)return;",
  "parent.postMessage({type:'pichamber-app-command',appId:APP_ID,token:TOKEN,",
  "command:el.getAttribute('data-pichamber-command'),",
  "args:el.getAttribute('data-pichamber-args')||''},'*');});",
  '})();</script>',
].join('\n');

const buildSandboxedDocument = (html: string, appId: string, token: string): string => {
  const bridge = BRIDGE_SCRIPT_TEMPLATE
    .replace('__PICHAMBER_TOKEN__', JSON.stringify(token))
    .replace('__PICHAMBER_APP_ID__', JSON.stringify(appId));
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${bridge}</body>`);
  return `${html}${bridge}`;
};

const ExtensionAppFrame: React.FC<{
  sessionId: string;
  appId: string;
  title?: string;
  html: string;
}> = ({ sessionId, appId, title, html }) => {
  const [hidden, setHidden] = React.useState(false);
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const tokenRef = React.useRef<string>('');

  // A fresh token per mount; a stale document cannot mint valid commands.
  if (tokenRef.current === '') {
    tokenRef.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  const token = tokenRef.current;

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        appId?: unknown;
        token?: unknown;
        command?: unknown;
        args?: unknown;
      } | null;
      if (!data || data.type !== 'pichamber-app-command') return;
      if (data.appId !== appId || data.token !== token) return;
      const command = typeof data.command === 'string' ? data.command : '';
      const args = normalizeExtensionCommandArgs(typeof data.args === 'string' ? data.args : undefined);
      if (!COMMAND_PATTERN.test(command)) return;
      const text = args.length > 0 ? `/${command} ${args}` : `/${command}`;
      void getPiSessionStore().prompt(sessionId, text, 'prompt').catch(() => {});
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [appId, token, sessionId]);

  if (hidden) return null;

  return (
    <div
      className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-[opacity,transform] duration-150"
      data-testid={`extension-app-${appId}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-interactive-hover text-muted-foreground">
            <Icon name="plug-2" className="size-3.5" />
          </span>
          <span className="truncate typography-ui-label font-medium text-foreground">
            {title ?? appId}
          </span>
        </div>
        <Button variant="ghost" size="xs" onClick={() => setHidden(true)} aria-label="Hide app surface">
          Hide
        </Button>
      </div>
      <iframe
        ref={iframeRef}
        title={title ?? appId}
        sandbox="allow-scripts"
        srcDoc={buildSandboxedDocument(html, appId, token)}
        className="w-full border-0 bg-background"
        style={{ height: MAX_APP_HEIGHT_PX }}
      />
    </div>
  );
};

/** Renders every registered app surface for the session above the composer. */
export const ExtensionAppSurfaces: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const apps = usePiSessionSnapshot(
    (state) => (
      activeSessionId
        ? [...(state.reducer.bySession.get(activeSessionId)?.extensionApps.values() ?? [])]
        : []
    ),
    (a, b) => (
      a.length === b.length && a.every((app, index) => {
        const other = b[index];
        return Boolean(other)
          && app.appId === other?.appId
          && app.title === other.title
          && app.html === other.html;
      })
    ),
    `session:${activeSessionId ?? ''}`,
  );

  if (!activeSessionId || apps.length === 0) return null;

  return (
    <div className="chat-input-column" data-testid="extension-app-surfaces">
      <div className="flex flex-col gap-3">
        {apps.map((app) => (
          <ExtensionAppFrame
            key={app.appId}
            sessionId={activeSessionId}
            appId={app.appId}
            title={app.title}
            html={app.html ?? ''}
          />
        ))}
      </div>
    </div>
  );
};
