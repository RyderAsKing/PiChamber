import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ServerBrowserStatus } from '@/lib/serverBrowser/protocol';
import { saveServerBrowserSettings } from '@/lib/serverBrowser/api';

const CommandLine: React.FC<{ command: string }> = ({ command }) => (
  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-[var(--surface-elevated)] py-1 pl-3 pr-1">
    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap typography-code text-foreground">{command}</code>
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => {
        void copyTextToClipboard(command).then((result) => {
          if (result.ok) toast.success('Command copied');
          else toast.error('Could not copy the command');
        });
      }}
    >
      {'Copy'}
    </Button>
  </div>
);

type Explanation = { title: string; body: string; commands: string[]; detail?: string };

const explain = (status: ServerBrowserStatus): Explanation => {
  const problem = status.problem;
  const install = status.installCommands;
  if (!problem || problem.kind === 'missing') {
    return {
      title: 'Install Chrome on the server',
      body: 'The server browser runs Google Chrome or Chromium on the machine running PiChamber. Install one there, then check again. To use a browser installed somewhere else, set PICHAMBER_BROWSER_CHROME to its executable and restart PiChamber.',
      commands: install,
    };
  }
  if (problem.kind === 'missing-env') {
    return {
      title: `${problem.envKey} does not point to a browser`,
      body: `PiChamber was started with ${problem.envKey} set, but no file exists at that path. Fix the path or unset it, then restart PiChamber.`,
      commands: [],
    };
  }
  if (problem.kind === 'sandbox-root' || (problem.kind === 'launch-failed' && problem.reason === 'sandbox-root')) {
    return {
      title: 'Chrome will not run as root with its sandbox',
      body: 'PiChamber runs as root on this server, and Chrome refuses to start its sandbox as root. Run PiChamber as a regular user, or allow Chrome to run without its sandbox below.',
      commands: [],
    };
  }
  if (problem.reason === 'missing-library') {
    return {
      title: 'Chrome is missing system libraries',
      body: `Chrome could not start because ${problem.library ?? 'a library'} is not installed on the server. Installing Chrome with its dependencies adds what it needs.`,
      commands: install,
      detail: problem.detail,
    };
  }
  if (problem.reason === 'sandbox-namespaces') {
    return {
      title: "Chrome's sandbox is not available",
      body: 'This server does not allow the user namespaces Chrome uses for its sandbox, which is common in containers. Enable unprivileged user namespaces, or allow Chrome to run without its sandbox below.',
      commands: [],
      detail: problem.detail,
    };
  }
  return {
    title: 'Chrome did not start',
    body: 'The server browser could not start Chrome. The output below may explain why.',
    commands: [],
    detail: problem.detail,
  };
};

const allowsNoSandboxChoice = (status: ServerBrowserStatus): boolean => {
  const problem = status.problem;
  if (!problem || status.allowNoSandbox) return false;
  if (problem.kind === 'sandbox-root') return true;
  return problem.kind === 'launch-failed' && (problem.reason === 'sandbox-root' || problem.reason === 'sandbox-namespaces');
};

/**
 * Explains why the server browser cannot start and how to fix it. Never
 * installs anything itself.
 */
export const ServerBrowserSetup: React.FC<{
  status: ServerBrowserStatus;
  onRetry: () => void;
  onUseDevice: () => void;
}> = ({ status, onRetry, onUseDevice }) => {
  const [saving, setSaving] = React.useState(false);
  const explanation = explain(status);

  const allowWithoutSandbox = async () => {
    setSaving(true);
    try {
      await saveServerBrowserSettings({ allowNoSandbox: true });
      onRetry();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the setting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-10">
        <div className="flex flex-col gap-1.5">
          <span className="typography-ui-header text-foreground [text-wrap:balance]">{explanation.title}</span>
          <p className="typography-meta text-muted-foreground [text-wrap:pretty]">{explanation.body}</p>
        </div>
        {explanation.commands.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="typography-micro text-muted-foreground">
              {explanation.commands.length === 1 ? 'Run this on the server:' : 'Run one of these on the server:'}
            </span>
            {explanation.commands.map((command) => <CommandLine key={command} command={command} />)}
          </div>
        ) : null}
        {allowsNoSandboxChoice(status) ? (
          <div className="flex flex-col gap-2">
            <p className="typography-micro text-muted-foreground [text-wrap:pretty]">
              {'Without its sandbox, a page that exploits a bug in Chrome can reach the server with the permissions PiChamber runs with. Only do this on a machine you are comfortable exposing to the sites you open.'}
            </p>
            <div>
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void allowWithoutSandbox()}>
                {'Allow without sandbox'}
              </Button>
            </div>
          </div>
        ) : null}
        {explanation.detail ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-[var(--surface-elevated)] p-3 typography-code text-muted-foreground">{explanation.detail}</pre>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={onRetry}>{'Check again'}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onUseDevice}>{'Load on this device instead'}</Button>
        </div>
      </div>
    </div>
  );
};
