import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { createHeaderDraft, type HeaderDraft } from './serverHeaderDrafts';

export type AddServerManualInput = {
  label: string;
  url: string;
  token: string;
  headers: HeaderDraft[];
};

export type AddServerStep = 'menu' | 'link' | 'manual';

export type AddServerDialogBodyProps = {
  open: boolean;
  step: AddServerStep;
  onStepChange: (step: AddServerStep) => void;
  onClose: () => void;
  canScanQr: boolean;
  onScanQr?: () => void;
  onImportLink: (link: string) => void;
  importSaving?: boolean;
  importError?: string | null;
  onAddManual: (input: AddServerManualInput) => void;
  manualSaving?: boolean;
  manualError?: string | null;
};

/**
 * Dialog body, exported for SSR tests (Base UI dialog portals render nothing
 * server-side, following the AddDeviceDialogBody precedent).
 */
export const AddServerDialogBody: React.FC<AddServerDialogBodyProps> = ({
  open,
  step,
  onStepChange,
  onClose,
  canScanQr,
  onScanQr,
  onImportLink,
  importSaving = false,
  importError = null,
  onAddManual,
  manualSaving = false,
  manualError = null,
}) => {
  const [link, setLink] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [headers, setHeaders] = React.useState<HeaderDraft[]>([]);

  React.useEffect(() => {
    if (!open) {
      setLink('');
      setLabel('');
      setUrl('');
      setToken('');
      setHeaders([]);
    }
  }, [open]);

  const busy = importSaving || manualSaving;

  if (step === 'menu') {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          className="w-full"
          disabled={busy}
          onClick={() => onStepChange('link')}
        >
          {'Paste a pairing link'}
        </Button>
        {canScanQr && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => onScanQr?.()}
          >
            {'Scan QR code'}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => onStepChange('manual')}
        >
          {'Enter address manually'}
        </Button>
        <p className="px-1 typography-micro text-muted-foreground">
          {'Manual entry is advanced: the server must already be running and reachable.'}
        </p>
      </div>
    );
  }

  if (step === 'link') {
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onImportLink(link);
        }}
      >
        <Input
          className="h-8"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder={'pichamber://connect?...'}
          disabled={busy}
          autoFocus
        />
        {importError ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{importError}</p>
        ) : null}
        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="!font-normal"
            onClick={() => onStepChange('menu')}
            disabled={busy}
          >
            {'Back'}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={onClose}
              disabled={busy}
            >
              {'Cancel'}
            </Button>
            <Button type="submit" size="xs" className="!font-normal" disabled={busy || !link.trim()}>
              {importSaving ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {'Import link'}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onAddManual({ label, url, token, headers });
      }}
    >
      <Input
        className="h-8"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder={'Label (optional)'}
        disabled={busy}
      />
      <Input
        className="h-8"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder={'https://host:port'}
        disabled={busy}
        autoFocus
      />
      <div className="space-y-1">
        <Input
          className="h-8"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={'Connection token (optional for trusted local servers)'}
          type="password"
          disabled={busy}
        />
        <p className="px-1 typography-micro text-muted-foreground">
          {'Connection tokens are saved on this device and used only when this app connects to that server.'}
        </p>
      </div>
      <div className="space-y-2">
        <p className="typography-ui-label font-medium text-foreground">
          {'Additional headers'}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {'Optional HTTP headers for desktop API requests. Authorization is reserved for the connection token.'}
          </span>
        </p>
        {headers.map((header) => (
          <div key={header.id} className="flex w-full gap-2">
            <Input
              className="h-8 font-mono text-xs"
              value={header.name}
              onChange={(event) =>
                setHeaders((items) =>
                  items.map((item) =>
                    item.id === header.id ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
              placeholder={'Header name'}
              disabled={busy}
            />
            <Input
              className="h-8 font-mono text-xs"
              value={header.value}
              onChange={(event) =>
                setHeaders((items) =>
                  items.map((item) =>
                    item.id === header.id ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
              placeholder={'Header value'}
              type="password"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setHeaders((items) => items.filter((item) => item.id !== header.id))}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              aria-label={'Remove header'}
              disabled={busy}
            >
              <Icon name="close" className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="!font-normal"
          onClick={() => setHeaders((items) => [...items, createHeaderDraft()])}
          disabled={busy}
        >
          <Icon name="add" className="h-3.5 w-3.5" aria-hidden="true" />
          {'Add header'}
        </Button>
      </div>
      {manualError ? (
        <p className="typography-meta text-[var(--status-error)]" role="alert">{manualError}</p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="!font-normal"
          onClick={() => onStepChange('menu')}
          disabled={busy}
        >
          {'Back'}
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={onClose}
            disabled={busy}
          >
            {'Cancel'}
          </Button>
          <Button type="submit" size="xs" className="!font-normal" disabled={busy || !url.trim()}>
            {'Add server'}
          </Button>
        </div>
      </div>
    </form>
  );
};

export type AddServerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Show the "Scan QR code" option (mobile only; desktop passes false). */
  canScanQr: boolean;
  onScanQr?: () => void;
  onImportLink: (link: string) => void;
  importSaving?: boolean;
  importError?: string | null;
  onAddManual: (input: AddServerManualInput) => void;
  manualSaving?: boolean;
  manualError?: string | null;
  initialStep?: AddServerStep;
};

/**
 * One entry point for adding a server: paste a pairing link (primary),
 * scan a QR code (only when `canScanQr`), or enter an address manually
 * (advanced). Presentational: field state lives in the body, persistence and
 * the pairing redeem flow live with the caller.
 */
export const AddServerDialog: React.FC<AddServerDialogProps> = ({
  open,
  onOpenChange,
  canScanQr,
  onScanQr,
  onImportLink,
  importSaving = false,
  importError = null,
  onAddManual,
  manualSaving = false,
  manualError = null,
  initialStep = 'menu',
}) => {
  const [step, setStep] = React.useState<AddServerStep>(initialStep);

  React.useEffect(() => {
    if (open) setStep(initialStep);
  }, [open, initialStep]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{'Add server'}</DialogTitle>
          <DialogDescription>
            {step === 'manual'
              ? 'Add another PiChamber server by address. Use this when the server is already running and you have a connection token.'
              : step === 'link'
                ? 'Paste a pairing link from another PiChamber server.'
                : 'Import a pairing link from the other server, or add one by address.'}
          </DialogDescription>
        </DialogHeader>
        <AddServerDialogBody
          open={open}
          step={step}
          onStepChange={setStep}
          onClose={() => onOpenChange(false)}
          canScanQr={canScanQr}
          onScanQr={onScanQr}
          onImportLink={onImportLink}
          importSaving={importSaving}
          importError={importError}
          onAddManual={onAddManual}
          manualSaving={manualSaving}
          manualError={manualError}
        />
      </DialogContent>
    </Dialog>
  );
};
