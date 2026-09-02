import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';

export interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: 'configure' | 'result';
  remoteClientLabel: string;
  onRemoteClientLabelChange: (val: string) => void;
  remoteClientError: string | null;
  addDeviceTransport: 'local' | 'lan' | 'relay';
  onAddDeviceTransportChange: (transport: 'local' | 'lan' | 'relay') => void;
  addDeviceFallback: boolean;
  onAddDeviceFallbackChange: (fallback: boolean) => void;
  transportOptions: { localUrl: string | null; lanUrl: string | null; relayAvailable: boolean } | null;
  addDeviceCreating: boolean;
  onCreatePairingLink: () => void;
  pairingQrDataUrl: string | null;
  pairingUrl: string | null;
  pairingCopied: boolean;
  onCopyPairing: () => void;
}

export const AddDeviceDialog: React.FC<AddDeviceDialogProps> = ({
  open,
  onOpenChange,
  phase,
  remoteClientLabel,
  onRemoteClientLabelChange,
  remoteClientError,
  addDeviceTransport,
  onAddDeviceTransportChange,
  addDeviceFallback,
  onAddDeviceFallbackChange,
  transportOptions,
  addDeviceCreating,
  onCreatePairingLink,
  pairingQrDataUrl,
  pairingUrl,
  pairingCopied,
  onCopyPairing,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={phase === 'result' ? 'sm:max-w-lg' : 'sm:max-w-md'}>
        <DialogHeader>
          <DialogTitle>{phase === 'result' ? "Scan to connect" : "Add a device"}</DialogTitle>
          <DialogDescription>
            {phase === 'result'
              ? "Scan this with the PiChamber app on your other device. It is single-use and expires."
              : "Create a one-time QR code that connects another device to this server."}
          </DialogDescription>
        </DialogHeader>
        {phase === 'configure' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onCreatePairingLink();
            }}
          >
            <Input
              className="h-8"
              value={remoteClientLabel}
              onChange={(event) => onRemoteClientLabelChange(event.target.value)}
              placeholder={"Device name — e.g. My iPhone"}
              autoFocus
            />
            <div className="space-y-1.5">
              <p className="typography-ui-label text-foreground">{"Where will you use this device?"}</p>
              <div role="radiogroup" aria-label={"Where will you use this device?"} className="space-y-1.5">
                {[
                  {
                    key: 'relay' as const,
                    label: "Anywhere",
                    hint: "Works at home and away. Away traffic goes through PiChamber Private Relay — an end-to-end encrypted tunnel. No setup needed.",
                    available: Boolean(transportOptions?.relayAvailable),
                  },
                  {
                    key: 'lan' as const,
                    label: "Home network only",
                    hint: "Connects directly over your Wi-Fi. Does not work away from this network.",
                    available: Boolean(transportOptions?.lanUrl),
                  },
                  {
                    key: 'local' as const,
                    label: "This computer only",
                    hint: "For apps running on this same machine.",
                    available: Boolean(transportOptions?.localUrl),
                  },
                ].map((option) => {
                  const selected = addDeviceTransport === option.key;
                  return (
                    <div
                      key={option.key}
                      className={cn('flex items-start gap-2 py-0.5', option.available ? 'cursor-pointer' : 'opacity-45')}
                      onClick={() => {
                        if (option.available) onAddDeviceTransportChange(option.key);
                      }}
                      role="presentation"
                    >
                      <Radio
                        checked={selected}
                        disabled={!option.available}
                        onChange={() => onAddDeviceTransportChange(option.key)}
                        ariaLabel={option.label}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/70')}>
                          {option.label}
                        </p>
                        <p className="typography-meta text-muted-foreground">{option.hint}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {addDeviceTransport === 'lan' ? (
                <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                  <Checkbox
                    checked={addDeviceFallback}
                    onChange={onAddDeviceFallbackChange}
                    ariaLabel={"Also allow the encrypted relay when away from home"}
                  />
                  <span className="typography-meta text-muted-foreground">
                    {"Also allow the encrypted relay when away from home"}
                  </span>
                </label>
              ) : null}
              {addDeviceTransport === 'relay' && transportOptions?.lanUrl ? (
                <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                  <Checkbox
                    checked={addDeviceFallback}
                    onChange={onAddDeviceFallbackChange}
                    ariaLabel={"Prefer the direct home connection when available"}
                  />
                  <span className="typography-meta text-muted-foreground">
                    {"Prefer the direct home connection when available"}
                  </span>
                </label>
              ) : null}
            </div>
            {remoteClientError ? (
              <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => onOpenChange(false)}
                disabled={addDeviceCreating}
              >
                {"Cancel"}
              </Button>
              <Button
                type="submit"
                size="xs"
                className="!font-normal"
                disabled={addDeviceCreating || !transportOptions}
              >
                {"Create QR code"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            {pairingQrDataUrl ? (
              <div className="flex justify-center">
                <img
                  src={pairingQrDataUrl}
                  alt={"PiChamber connection QR code"}
                  className="w-full max-w-[420px] rounded-md bg-white p-4"
                />
              </div>
            ) : null}
            {pairingUrl ? (
              <div className="flex items-center gap-2 rounded-md border border-[var(--interactive-border)] p-2">
                <code className="min-w-0 flex-1 truncate typography-code text-muted-foreground">{pairingUrl}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={onCopyPairing}
                >
                  <Icon
                    name={pairingCopied ? 'check' : 'file-copy'}
                    className={cn('h-3.5 w-3.5', pairingCopied && 'text-[var(--status-success)]')}
                  />
                  {pairingCopied ? "Copied" : "Copy all"}
                </Button>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="button"
                size="xs"
                className="!font-normal"
                onClick={() => onOpenChange(false)}
              >
                {"Done"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
