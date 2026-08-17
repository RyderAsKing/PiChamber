import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { SettingsView } from './SettingsView';

interface SettingsWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Settings rendered as a centered window with blurred backdrop.
 * Used for desktop and web (non-mobile) environments.
 */
export const SettingsWindow: React.FC<SettingsWindowProps> = ({ open, onOpenChange }) => {
  
  const descriptionId = React.useId();

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'oc-glass-backdrop fixed inset-0 z-50 bg-black/25 dark:bg-black/40',
            'transition-opacity duration-150 ease-out',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            aria-describedby={descriptionId}
            className={cn(
              'relative pointer-events-auto',
              'w-[92vw] max-w-[1120px] h-[84vh] max-h-[900px]',
              'rounded-2xl border border-border/80 shadow-2xl overflow-hidden origin-center',
              'bg-sidebar',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
              // Dim this window when a nested dialog (e.g. "Add a device") opens
              // on top of it, mirroring how the page behind a dialog is dimmed.
              'data-[nested-dialog-open]:brightness-[0.55] dark:data-[nested-dialog-open]:brightness-[0.4]',
            )}
          >
            <Dialog.Description id={descriptionId} className="sr-only">
              {"PiChamber settings window."}
            </Dialog.Description>
            <SettingsView onClose={() => onOpenChange(false)} isWindowed />
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
