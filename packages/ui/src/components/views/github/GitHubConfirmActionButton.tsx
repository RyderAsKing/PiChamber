import React from 'react';
import { useTranslation } from 'react-i18next';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';

/**
 * Shared anchored confirm popover for state-changing GitHub actions
 * (close/reopen/merge/...): a small popover anchored to the button itself
 * with a title, a one-sentence consequence, and Cancel + confirm (with a
 * progress label while busy). Replaces modal confirm dialogs.
 *
 * Extracted from the pull-request detail's `ConfirmActionButton` so issues
 * reuse the exact same pattern. PullDetail keeps its local copy for now
 * (a concurrent worker is editing that file) — see the handoff note.
 */
export const GitHubConfirmActionButton: React.FC<{
  copy: { title: string; detail: string; confirm: string; progress: string };
  busy: boolean;
  destructive?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  label: string;
  variant?: 'default' | 'outline' | 'destructive' | 'ghost' | 'secondary';
  icon?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
}> = ({ copy, busy, destructive, disabled, disabledReason, label, variant = 'default', icon, onConfirm }) => {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <Popover.Trigger
        render={
          <Button
            type="button"
            variant={variant}
            size="xs"
            className="shrink-0"
            disabled={disabled || busy}
            title={disabledReason ?? label}
            aria-label={label}
          />
        }
      >
        {icon}
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup
            aria-label={copy.title}
            className="w-64 rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-3 shadow-lg"
          >
            <p className="typography-ui-label text-foreground">{copy.title}</p>
            <p className="mt-1 typography-micro text-muted-foreground">{copy.detail}</p>
            <div className="mt-3 flex justify-end gap-1.5">
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                variant={destructive ? 'destructive' : 'default'}
                size="xs"
                disabled={busy}
                onClick={() => void Promise.resolve(onConfirm()).finally(() => setOpen(false))}
                aria-label={copy.confirm}
              >
                {busy ? copy.progress : copy.confirm}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
