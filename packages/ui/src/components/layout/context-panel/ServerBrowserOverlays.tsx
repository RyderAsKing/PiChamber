import React from 'react';

import { Button } from '@/components/ui/button';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import type { ServerBrowserConnectionPhase } from '@/lib/serverBrowser/connection';
import type { ServerBrowserDialog, ServerBrowserStatus } from '@/lib/serverBrowser/protocol';

import { pageHost } from './browserScripts';
import { ServerBrowserDevServers } from './ServerBrowserDevServers';
import { ServerBrowserSetup } from './ServerBrowserSetup';

const dialogText = (dialog: ServerBrowserDialog): { message: string; accept: string; dismiss: string | null } => {
  if (dialog.kind === 'beforeunload') return { message: 'Leave this page? Changes you made may not be saved.', accept: 'Leave', dismiss: 'Stay' };
  if (dialog.kind === 'alert') return { message: dialog.message, accept: 'OK', dismiss: null };
  return { message: dialog.message, accept: 'OK', dismiss: 'Cancel' };
};

/** The bar shown while the page waits for files from this device. */
export const FileChooserBar: React.FC<{
  multiple: boolean;
  uploading: boolean;
  onChoose: () => void;
  onCancel: () => void;
}> = ({ multiple, uploading, onChoose, onCancel }) => (
  <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-2">
    <span className="min-w-0 flex-1 typography-micro text-foreground">
      {multiple ? 'This page asks for files.' : 'This page asks for a file.'}
    </span>
    <Button type="button" size="xs" disabled={uploading} onClick={onChoose}>
      {uploading ? 'Uploading...' : multiple ? 'Choose files' : 'Choose file'}
    </Button>
    <Button type="button" variant="ghost" size="xs" disabled={uploading} onClick={onCancel}>
      {'Cancel'}
    </Button>
  </div>
);

/** A page's alert, confirm, prompt, or leave-page dialog. */
export const PageDialog: React.FC<{
  dialog: ServerBrowserDialog;
  promptText: string;
  onPromptTextChange: (text: string) => void;
  onRespond: (accept: boolean) => void;
}> = ({ dialog, promptText, onPromptTextChange, onRespond }) => {
  const copy = dialogText(dialog);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/60 p-4">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-[var(--surface-elevated)] p-4 shadow-lg"
        onSubmit={(event) => { event.preventDefault(); onRespond(true); }}
      >
        <span className="typography-micro text-muted-foreground">{`${pageHost(dialog.url)} says`}</span>
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap typography-meta text-foreground [text-wrap:pretty]">{copy.message}</p>
        {dialog.kind === 'prompt' ? (
          <input
            autoFocus
            value={promptText}
            onChange={(event) => onPromptTextChange(event.target.value)}
            className="h-8 rounded-md border border-border/50 bg-background px-2 typography-meta text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label="Answer"
          />
        ) : null}
        <div className="flex justify-end gap-2">
          {copy.dismiss ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onRespond(false)}>{copy.dismiss}</Button>
          ) : null}
          <Button type="submit" size="sm" autoFocus={dialog.kind !== 'prompt'}>{copy.accept}</Button>
        </div>
      </form>
    </div>
  );
};

export const CrashedPage: React.FC<{ onReload: () => void }> = ({ onReload }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
    <span className="typography-ui-header text-foreground">{'This page crashed'}</span>
    <Button type="button" variant="outline" size="sm" onClick={onReload}>{'Reload'}</Button>
  </div>
);

/**
 * What covers the page for the connection's state: setup help when the
 * browser is unavailable, a retry after a failure, progress while
 * connecting, and the server's dev servers on an empty page.
 */
export const ConnectionOverlay: React.FC<{
  phase: ServerBrowserConnectionPhase;
  status: ServerBrowserStatus | null;
  failure: string;
  hasFrame: boolean;
  showBlank: boolean;
  directory: string;
  onRetry: () => void;
  onSetupRetry: () => void;
  onUseDevice: () => void;
  onOpenAddress: (url: string) => void;
}> = ({ phase, status, failure, hasFrame, showBlank, directory, onRetry, onSetupRetry, onUseDevice, onOpenAddress }) => {
  if (phase === 'unavailable') {
    if (status) return <ServerBrowserSetup status={status} onRetry={onSetupRetry} onUseDevice={onUseDevice} />;
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <span className="typography-ui-header text-foreground">{'The server browser is not available'}</span>
        {failure ? <span className="max-w-md typography-micro text-muted-foreground [text-wrap:pretty]">{failure}</span> : null}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>{'Try again'}</Button>
      </div>
    );
  }
  if (phase === 'failed') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <span className="typography-ui-header text-foreground">{'Could not open this tab'}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>{'Try again'}</Button>
      </div>
    );
  }
  if ((phase === 'connecting' || phase === 'reconnecting') && !hasFrame) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background typography-micro text-muted-foreground">
        {phase === 'connecting' ? 'Starting the server browser...' : 'Reconnecting to the server browser...'}
      </div>
    );
  }
  if (phase === 'reconnecting') {
    return (
      <div className="absolute inset-x-0 top-0 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5 typography-micro text-muted-foreground">
        {'Reconnecting to the server browser...'}
      </div>
    );
  }
  if (!showBlank) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center-safe gap-6 overflow-y-auto bg-background p-6 text-center">
      <PiChamberLogo width={140} height={140} className="opacity-20" />
      <span className="typography-ui-header text-muted-foreground">{'Web browser'}</span>
      <span className="max-w-sm typography-micro text-muted-foreground [text-wrap:pretty]">
        {'Pages run in a browser on the PiChamber server, so localhost addresses reach the server.'}
      </span>
      <ServerBrowserDevServers directory={directory} onOpen={onOpenAddress} />
    </div>
  );
};
