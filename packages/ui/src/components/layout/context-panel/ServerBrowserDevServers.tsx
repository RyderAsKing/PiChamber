import React from 'react';

import { fetchServerBrowserDevServers, type ServerBrowserDevServer } from '@/lib/serverBrowser/api';

const POLL_MS = 5_000;
// Other servers are often system services; show only a few.
const MAX_OTHERS = 5;

type Groups = { project: ServerBrowserDevServer[]; others: ServerBrowserDevServer[] };

/**
 * The project's own servers, then web pages elsewhere on the machine.
 * Listeners outside the project without a page title are usually APIs or
 * system services, so they are left out.
 */
const groupServers = (servers: ServerBrowserDevServer[]): Groups => ({
  project: servers.filter((server) => server.inProject),
  others: servers.filter((server) => !server.inProject && server.title).slice(0, MAX_OTHERS),
});

const ServerList: React.FC<{ label: string; servers: ServerBrowserDevServer[]; onOpen: (url: string) => void }> = ({ label, servers, onOpen }) => (
  <div className="flex flex-col gap-1.5">
    <span className="px-1 typography-micro text-muted-foreground">{label}</span>
    <div className="flex flex-col overflow-hidden rounded-md border border-border/60">
      {servers.map((server) => {
        const address = `localhost:${server.port}`;
        return (
          <button
            key={server.port}
            type="button"
            className="flex min-w-0 flex-col gap-0.5 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none"
            onClick={() => onOpen(server.url)}
          >
            <span className="truncate typography-ui-label text-foreground">{server.title || address}</span>
            <span className="truncate typography-micro text-muted-foreground">
              {[server.title ? address : null, server.process].filter(Boolean).join(' · ')}
            </span>
          </button>
        );
      })}
    </div>
  </div>
);

/**
 * Web servers running on the PiChamber server, such as dev servers an agent
 * started. Polls while mounted; keeps the last list when a check fails.
 */
export const ServerBrowserDevServers: React.FC<{
  directory: string;
  onOpen: (url: string) => void;
}> = ({ directory, onOpen }) => {
  const [groups, setGroups] = React.useState<Groups | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const check = async () => {
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        try {
          const found = await fetchServerBrowserDevServers(directory, controller.signal);
          if (!cancelled) setGroups(groupServers(found));
        } catch {
          // Keep the last list; a failed check does not mean nothing is running.
        }
      }
      if (!cancelled) timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [directory]);

  if (!groups || (groups.project.length === 0 && groups.others.length === 0)) return null;

  return (
    <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-4 text-left">
      {groups.project.length > 0 ? <ServerList label="Running in this project" servers={groups.project} onOpen={onOpen} /> : null}
      {groups.others.length > 0 ? (
        <ServerList label={groups.project.length > 0 ? 'Other servers' : 'Running on the server'} servers={groups.others} onOpen={onOpen} />
      ) : null}
    </div>
  );
};
