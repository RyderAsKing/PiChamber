import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import {
  SettingsDisclosure,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useTailscaleAccessState } from './useTailscaleAccessState';
import {
  getTailscaleModeValue,
  isTailscaleModeAllowed,
  presentTailscaleStatus,
  type TailscaleModeValue,
} from './tailscaleViewModel';
import { RouteAddress, RouteRow, RouteStatusPill } from './RouteRow';
import { useCopyFeedback } from './useCopyFeedback';

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const OPERATOR_FIX_COMMAND = 'sudo tailscale set --operator=$USER';

const MODE_OPTIONS: Array<{ value: TailscaleModeValue; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
];

const MODE_DESCRIPTION: Record<TailscaleModeValue, string> = {
  off: 'Tailscale is not used.',
  private: 'Only devices signed in to your Tailscale.',
  public: 'Reachable from the internet through Tailscale Funnel. Devices still need to be paired.',
};

/** Moves keyboard focus (and scroll) to the desktop UI password control. */
const focusDesktopPasswordControl = () => {
  const target = document.getElementById('desktop-ui-password');
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => target.focus({ preventScroll: true }), 250);
};

/** Human-readable mutation failure: 403/422/server text/network never render as silent success. */
const describeActionError = (message: string | null, code: string | null): string | null => {
  if (!message) return null;
  if (code === 'auth_required') {
    return `${message} (auth_required)`;
  }
  if (code === 'invalid_config') {
    return `${message} (invalid_config)`;
  }
  if (code) {
    return `${message} (${code})`;
  }
  if (/failed to fetch|networkerror|load failed|fetch/i.test(message)) {
    return `${message} Check your connection and try again.`;
  }
  return message;
};

/**
 * Tailscale route row: Off / Private / Public segmented control plus
 * actionable UI for every status-model state.
 *
 * The mode picker is a radiogroup (arrow-key navigable) so the Public
 * option stays reachable by keyboard and assistive tech. Off is always
 * enabled once a status is known; Private/Public disable individually for
 * missing prerequisites or the per-mode server auth gate.
 */
export const TailscaleRouteRow: React.FC = () => {
  const tailscale = useTailscaleAccessState();
  const {
    status,
    initialLoading,
    loadFailed,
    loadError,
    actionError,
    actionErrorCode,
    mutationInFlight,
    pendingMode,
    confirmPublicOpen,
  } = tailscale;
  const isDesktop = isDesktopShell();
  const presentation = presentTailscaleStatus(status);
  const currentMode: TailscaleModeValue = status ? getTailscaleModeValue(status) : 'off';
  const activeMode = pendingMode ?? currentMode;
  const { copied: fixCopied, copy: copyFix } = useCopyFeedback();

  const prereqMissing = Boolean(presentation?.controlDisabled);
  const privateAllowed = isTailscaleModeAllowed(status, 'private');
  const publicAllowed = isTailscaleModeAllowed(status, 'public');
  const authBlocked = status ? (!privateAllowed || !publicAllowed) : false;

  const isOptionDisabled = (option: TailscaleModeValue): boolean => {
    if (mutationInFlight) return true;
    if (option === 'off') return false;
    if (prereqMissing) return true;
    if (option === 'private') return !privateAllowed;
    if (option === 'public') return !publicAllowed;
    return false;
  };

  const optionDisabledReason = (option: TailscaleModeValue): string | null => {
    if (option === 'off' || !status) return null;
    if (prereqMissing) return presentation?.controlDisabledReason ?? null;
    if (option === 'private' && !privateAllowed) return 'Set a UI password first';
    if (option === 'public' && !publicAllowed) return 'Set a UI password first';
    return null;
  };

  const groupRef = React.useRef<HTMLDivElement>(null);

  const focusOption = React.useCallback((option: TailscaleModeValue) => {
    const el = groupRef.current?.querySelector<HTMLButtonElement>(`[data-mode="${option}"]`);
    el?.focus();
  }, []);

  const handleGroupKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    const order: TailscaleModeValue[] = ['off', 'private', 'public'];
    const currentIndex = order.indexOf(activeMode);
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    for (let step = 1; step <= order.length; step += 1) {
      const next = order[(currentIndex + direction * step + order.length) % order.length] as TailscaleModeValue;
      if (!isOptionDisabled(next)) {
        focusOption(next);
        tailscale.setMode(next);
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode, mutationInFlight, prereqMissing, privateAllowed, publicAllowed, status]);

  const pill = initialLoading || !presentation
    ? <RouteStatusPill tone="neutral">{loadFailed ? 'Unknown' : 'Checking…'}</RouteStatusPill>
    : (
      <RouteStatusPill tone={mutationInFlight && pendingMode ? 'info' : presentation.tone}>
        {mutationInFlight && pendingMode ? 'Saving…' : presentation.pill}
      </RouteStatusPill>
    );

  const showGetTailscale = Boolean(status) && (status?.installed === false || status?.errorCode === 'not_installed');
  const showCheckAgain = Boolean(status)
    && status?.installed !== false
    && (status?.running === false || status?.loggedIn === false
      || status?.errorCode === 'not_running' || status?.errorCode === 'not_logged_in');

  const readableActionError = describeActionError(actionError, actionErrorCode);

  return (
    <RouteRow
      id="remote-access-tailscale-row"
      icon="global"
      title={'Tailscale'}
      pill={pill}
      description={'Reach this computer through your Tailscale network, at home or away.'}
      settingsItem="remote-access.tailscale"
    >
      {initialLoading && !status ? (
        <p className="typography-meta text-muted-foreground" role="status">{'Checking Tailscale status…'}</p>
      ) : loadFailed && !status ? (
        <div className="space-y-2">
          <p className="typography-meta text-[var(--status-error)]" role="alert">
            {loadError ?? "Couldn't load Tailscale status."}
          </p>
          <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={tailscale.reload}>
            {'Try again'}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div
            ref={groupRef}
            role="radiogroup"
            aria-label="Tailscale mode"
            className="flex flex-wrap items-center gap-1"
            onKeyDown={handleGroupKeyDown}
          >
            {MODE_OPTIONS.map((option) => {
              const disabled = isOptionDisabled(option.value);
              const reason = optionDisabledReason(option.value);
              const checked = activeMode === option.value;
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant="chip"
                  size="xs"
                  data-mode={option.value}
                  role="radio"
                  aria-checked={checked}
                  aria-label={reason ? `${option.label} (${reason})` : option.label}
                  title={reason ?? undefined}
                  disabled={disabled}
                  aria-pressed={undefined}
                  className="!font-normal"
                  onClick={() => tailscale.setMode(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          {mutationInFlight && pendingMode ? (
            <p className="typography-meta text-muted-foreground" role="status">
              {'Saving…'}
            </p>
          ) : null}
          {prereqMissing ? null : (
            <p className={SETTINGS_HELPER_CLASS}>{MODE_DESCRIPTION[activeMode]}</p>
          )}

          {authBlocked && !prereqMissing ? (
            <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
              <p className="typography-ui-label font-medium text-foreground">{'Set a UI password first'}</p>
              {isDesktop ? (
                <>
                  <p className="typography-meta text-muted-foreground mt-0.5">
                    {!privateAllowed && !publicAllowed
                      ? 'Private and Public need a desktop UI password before they can be enabled.'
                      : !publicAllowed
                        ? 'Public needs a desktop UI password before it can be enabled.'
                        : 'Private needs a desktop UI password before it can be enabled.'}
                  </p>
                  <div className="mt-2">
                    <Button
                      type="button"
                      size="xs"
                      className="!font-normal"
                      onClick={focusDesktopPasswordControl}
                    >
                      {'Go to password'}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="typography-meta text-muted-foreground mt-0.5">
                  {'Tailscale needs a UI password. Start the server with --ui-password or set PICHAMBER_UI_PASSWORD.'}
                </p>
              )}
            </div>
          ) : null}

          {presentation?.headline && presentation.showUrl !== true ? (
            <p className="typography-ui-label text-foreground">{presentation.headline}</p>
          ) : null}

          {presentation?.showUrl && status?.url ? (
            <div className="space-y-1.5">
              <RouteAddress
                url={status.url}
                copyLabel="Copy Tailscale address"
                action={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={() => void openExternalUrl(status.url as string)}
                    aria-label="Open Tailscale address"
                  >
                    <Icon name="external-link" className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              />
            </div>
          ) : null}

          {showGetTailscale ? (
            <div className="space-y-1.5">
              <p className="typography-meta text-muted-foreground">
                {'Install Tailscale on this computer, then sign in to the same tailnet as your phone.'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={() => void openExternalUrl(TAILSCALE_DOWNLOAD_URL)}
                >
                  {'Get Tailscale'}
                  <Icon name="external-link" className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={tailscale.retryNow}
                  disabled={mutationInFlight}
                >
                  {'Check again'}
                </Button>
              </div>
            </div>
          ) : null}

          {showCheckAgain ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="typography-meta text-muted-foreground">
                {'Open Tailscale and sign in, then check again.'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={tailscale.retryNow}
                disabled={mutationInFlight}
              >
                {'Check again'}
              </Button>
            </div>
          ) : null}

          {presentation?.showAuthCallout ? (
            <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
              <p className="typography-ui-label font-medium text-foreground">{'Set a password first'}</p>
              {isDesktop ? (
                <>
                  <p className="typography-meta text-muted-foreground mt-0.5">
                    {'Tailscale needs a desktop UI password before it can be enabled.'}
                  </p>
                  <div className="mt-2">
                    <Button
                      type="button"
                      size="xs"
                      className="!font-normal"
                      onClick={focusDesktopPasswordControl}
                    >
                      {'Go to password'}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="typography-meta text-muted-foreground mt-0.5">
                  {'Tailscale needs a UI password. Start the server with --ui-password or set PICHAMBER_UI_PASSWORD.'}
                </p>
              )}
            </div>
          ) : null}

          {status?.state === 'starting' ? (
            <p className="flex items-center gap-2 typography-meta text-muted-foreground" role="status">
              <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {'Setting up…'}
              {presentation?.showStartingNote ? (
                <span>{'First-time public addresses can take up to ~10 minutes.'}</span>
              ) : null}
            </p>
          ) : null}

          {presentation?.showApproval ? (
            <div className="space-y-1.5">
              <p className="typography-meta text-muted-foreground" role="status">
                {'Waiting for approval…'}
              </p>
              {status?.approvalUrl ? (
                <Button
                  type="button"
                  size="xs"
                  className="!font-normal"
                  onClick={() => void openExternalUrl(status.approvalUrl as string)}
                >
                  {'Approve in Tailscale'}
                  <Icon name="external-link" className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}

          {presentation?.showPermissionFix ? (
            <div className="space-y-1.5">
              <div className="flex min-w-0 max-w-[24rem] items-center gap-1.5 rounded-md border border-[var(--interactive-border)] px-2 py-1.5">
                <code className="min-w-0 flex-1 truncate font-mono typography-micro text-foreground">
                  {OPERATOR_FIX_COMMAND}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={() => copyFix(OPERATOR_FIX_COMMAND)}
                  aria-label={fixCopied ? 'Fix command copied' : 'Copy fix command'}
                >
                  <Icon
                    name={fixCopied ? 'check' : 'file-copy'}
                    className={cn('h-3.5 w-3.5', fixCopied && 'text-[var(--status-success)]')}
                    aria-hidden
                  />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={tailscale.retryNow}
                disabled={mutationInFlight}
              >
                {'Try again'}
              </Button>
            </div>
          ) : null}

          {status?.state === 'error' && !presentation?.showPermissionFix ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={tailscale.retryNow}
                disabled={mutationInFlight}
              >
                {'Try again'}
              </Button>
            </div>
          ) : null}

          {readableActionError ? (
            <p className="typography-meta text-[var(--status-error)]" role="alert">
              {readableActionError}
            </p>
          ) : null}

          {status && status.config.enabled ? (
            <SettingsDisclosure label="Advanced">
              <div className="space-y-2" data-settings-item="remote-access.tailscale-port">
                <p className={SETTINGS_HELPER_CLASS}>
                  {'HTTPS port for the Tailscale address. Public (Funnel) addresses only allow 443, 8443, or 10000.'}
                </p>
                <div role="radiogroup" aria-label="Tailscale HTTPS port" className="flex flex-wrap items-center gap-1">
                  {['443', '8443', '10000'].map((port) => (
                    <Button
                      key={port}
                      type="button"
                      variant="chip"
                      size="xs"
                      role="radio"
                      aria-checked={String(status.config.httpsPort) === port}
                      aria-label={`Port ${port}`}
                      className="!font-normal"
                      disabled={mutationInFlight}
                      onClick={() => tailscale.setPort(Number(port) as 443 | 8443 | 10000)}
                    >
                      {port}
                    </Button>
                  ))}
                </div>
              </div>
            </SettingsDisclosure>
          ) : null}
        </div>
      )}

      <Dialog open={confirmPublicOpen} onOpenChange={(next) => { if (!next) tailscale.cancelPublicConfirm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{'Make PiChamber reachable from the internet?'}</DialogTitle>
            <DialogDescription>
              {'Anyone with the address can reach the sign-in page. Devices still need to be paired, and the UI password protects browser sign-in. If your phone has Tailscale, Private is the safer choice.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={tailscale.cancelPublicConfirm}
            >
              {'Cancel'}
            </Button>
            <Button
              type="button"
              size="xs"
              className="!font-normal"
              onClick={tailscale.confirmPublic}
            >
              {'Make public'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </RouteRow>
  );
};
