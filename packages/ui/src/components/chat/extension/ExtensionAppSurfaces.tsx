import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { parseExtensionAppCommand } from '@/lib/pi/extension-app-command';
import { Button } from '@/components/ui/button';

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

export const ExtensionAppFrame: React.FC<{
  sessionId: string;
  appId: string;
  title?: string;
  html: string;
}> = ({ sessionId, appId, title, html }) => {
  const { t } = useTranslation();
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
      const promptText = parseExtensionAppCommand(event.data, { appId, token });
      if (!promptText) return;
      void getPiSessionStore().prompt(sessionId, promptText, 'prompt').catch(() => {});
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [appId, token, sessionId]);

  if (hidden) return null;

  return (
    <div
      className="overflow-hidden rounded-md border border-border/60 bg-background"
      data-testid={`extension-app-${appId}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1">
        <span className="min-w-0 truncate typography-ui-label text-foreground" title={title ?? appId}>
          {title ?? appId}
        </span>
        <Button variant="ghost" size="xs" onClick={() => setHidden(true)} aria-label={t('Hide app surface')}>
          {t('Hide')}
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
