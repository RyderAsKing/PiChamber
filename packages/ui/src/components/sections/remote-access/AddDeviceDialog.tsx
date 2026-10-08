import React from 'react';
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
import type { AddDeviceApi } from './useAddDeviceState';

export interface AddDeviceDialogProps {
  addDevice: AddDeviceApi;
  /** Desktop shell can turn on LAN from settings; web shows Tailscale setup only. */
  isDesktop: boolean;
}

/**
 * Simplified Add-a-device dialog: opening immediately creates one pairing
 * session covering every available route. No transport picker, no name
 * field (the redeeming client names itself).
 *
 * The body is exported separately so it stays unit-testable: the Base UI
 * dialog portal renders nothing under SSR.
 */
export const AddDeviceDialogBody: React.FC<{ addDevice: AddDeviceApi; isDesktop: boolean }> = ({ addDevice, isDesktop }) => {
  const {
    phase,
    creating,
    loopbackOnly,
    pairingUrl,
    pairingQrDataUrl,
    pairingCopied,
    countdownText,
    announcedCountdownText,
    routeChips,
    error,
    closeDialog,
    regenerate,
    copyLink,
    scrollToWays,
  } = addDevice;

  return (
    <>
        {loopbackOnly ? (
          <div className="space-y-3">
            <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
              <p className="typography-ui-label font-medium text-foreground">{"Other devices can't reach this computer yet"}</p>
              <p className="typography-meta text-muted-foreground mt-0.5">
                {'Turn on a route in Ways to connect so this code has somewhere to connect through.'}
              </p>
            </div>
            {!isDesktop ? (
              <p className="typography-meta text-muted-foreground">
                {'Local network needs the server started with --lan.'}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {isDesktop ? (
                <Button type="button" size="xs" className="!font-normal" onClick={() => scrollToWays('lan')}>
                  {'Turn on Local network'}
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant={isDesktop ? 'outline' : 'default'}
                className="!font-normal"
                onClick={() => scrollToWays('tailscale')}
              >
                {'Set up Tailscale'}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closeDialog}>
                {'Cancel'}
              </Button>
            </div>
          </div>
        ) : creating && !pairingUrl ? (
          <div className="flex items-center gap-2 py-6 typography-ui text-muted-foreground" role="status">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" aria-hidden />
            {'Creating secure code…'}
          </div>
        ) : (
          <div className="space-y-3">
            {pairingQrDataUrl ? (
              <div className="flex justify-center">
                <img
                  src={pairingQrDataUrl}
                  alt={'PiChamber connection QR code'}
                  className={cn(
                    'w-full max-w-[420px] rounded-md bg-white p-4',
                    phase === 'expired' && 'opacity-40 grayscale',
                  )}
                  aria-hidden={phase === 'expired'}
                />
              </div>
            ) : null}
            <p className="typography-ui-label text-center text-foreground">
              {phase === 'expired' ? 'Code expired' : 'Scan with the PiChamber app'}
            </p>
            {phase === 'ready' && countdownText ? (
              <>
                <p className="typography-meta text-center text-muted-foreground" aria-hidden>
                  {countdownText}
                </p>
                <p className="sr-only" aria-live="polite">
                  {announcedCountdownText ?? countdownText}
                </p>
              </>
            ) : null}
            {phase === 'expired' ? (
              <p className="typography-meta text-center text-muted-foreground">
                {'This code expired. Create a new one to keep pairing.'}
              </p>
            ) : null}
            {routeChips.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-1.5" aria-label="Included routes">
                {routeChips.map((chip) => (
                  <span
                    key={chip.key}
                    className="typography-micro text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0 leading-none border border-border/50"
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            ) : null}
            {phase === 'ready' ? (
              <p className="flex items-center justify-center gap-2 typography-meta text-muted-foreground" role="status">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" aria-hidden />
                {'Waiting for device…'}
              </p>
            ) : null}
            {error ? (
              <p className="typography-meta text-center text-[var(--status-error)]" role="alert">
                {error}
              </p>
            ) : null}
            {pairingUrl ? (
              <div className="flex items-center gap-2 rounded-md border border-[var(--interactive-border)] p-2">
                <code className="min-w-0 flex-1 truncate typography-code text-muted-foreground">{pairingUrl}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={copyLink}
                  aria-label={pairingCopied ? 'Pairing link copied' : 'Copy pairing link'}
                >
                  <Icon
                    name={pairingCopied ? 'check' : 'file-copy'}
                    className={cn('h-3.5 w-3.5', pairingCopied && 'text-[var(--status-success)]')}
                    aria-hidden
                  />
                  {pairingCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={closeDialog}
              >
                {'Cancel'}
              </Button>
              <Button
                type="button"
                variant={phase === 'expired' ? 'default' : 'outline'}
                size="xs"
                className="!font-normal"
                onClick={regenerate}
                disabled={creating}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" aria-hidden />
                {'New code'}
              </Button>
            </div>
          </div>
        )}
    </>
  );
};

export const AddDeviceDialog: React.FC<AddDeviceDialogProps> = ({ addDevice, isDesktop }) => {
  const showQrDescription = !addDevice.loopbackOnly && Boolean(addDevice.pairingQrDataUrl);
  return (
  <Dialog open={addDevice.open} onOpenChange={(next) => { if (!next) addDevice.closeDialog(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{'Add a device'}</DialogTitle>
        {showQrDescription ? (
        <DialogDescription>
          {'Scan this with the PiChamber app on your other device. It is single-use and expires.'}
        </DialogDescription>
        ) : null}
      </DialogHeader>
      <AddDeviceDialogBody addDevice={addDevice} isDesktop={isDesktop} />
    </DialogContent>
  </Dialog>
  );
};
