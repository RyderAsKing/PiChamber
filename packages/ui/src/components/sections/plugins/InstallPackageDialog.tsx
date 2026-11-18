import React from 'react';

import {
  SETTINGS_FIELD_LABEL_CLASS,
  SettingsRadioGroup,
  SettingsRadioOption,
} from '@/components/sections/shared/SettingsSection';
import { reportPackageWrite } from '@/components/sections/plugins/extensionWriteReport';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useExtensionConfigStore } from '@/plugins/extensionConfigStore';

type InstallScope = 'user' | 'project';

const folderName = (directory: string): string => {
  const parts = directory.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || directory;
};

/**
 * Confirms an install: says what installing means, and where it applies.
 * Installing runs in the background once confirmed; the button that opened
 * the dialog shows its progress and a toast reports the end.
 */
export function InstallPackageDialog({
  name,
  directory,
  projectTrusted,
  onClose,
}: {
  /** The npm package to install; `null` keeps the dialog closed. */
  name: string | null;
  /** The open folder, for the This project choice. */
  directory: string | null;
  /** Whether Pi trusts that folder; `undefined` while unknown. */
  projectTrusted: boolean | undefined;
  onClose: () => void;
}) {
  const installPackage = useExtensionConfigStore((state) => state.installPackage);
  const [scope, setScope] = React.useState<InstallScope>('user');
  // Keep the text while the dialog closes.
  const [shown, setShown] = React.useState(name);
  React.useEffect(() => {
    if (name) {
      setShown(name);
      setScope('user');
    }
  }, [name]);

  const canUseProject = Boolean(directory) && projectTrusted === true;

  const confirm = () => {
    if (!name) return;
    const target = scope === 'project' && canUseProject ? directory : null;
    onClose();
    reportSettingsSaveState('saving');
    void installPackage(name, target).then((result) => reportPackageWrite(result, name, 'install'));
  };

  let projectNote: string | undefined;
  if (directory && projectTrusted === false) projectNote = 'Pi does not trust this project, so it cannot install here.';
  else if (directory && projectTrusted === undefined) projectNote = 'Checking this project…';

  return (
    <Dialog open={name !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">{`Install ${shown ?? 'package'}?`}</DialogTitle>
          <DialogDescription className="text-pretty">
            {'A Pi package runs as code on the machine that runs PiChamber, with the same access as Pi. Install only packages you trust.'}
          </DialogDescription>
        </DialogHeader>

        {directory ? (
          <div className="space-y-2">
            <p className={SETTINGS_FIELD_LABEL_CLASS}>{'Load it in'}</p>
            <SettingsRadioGroup aria-label="Where to install">
              <SettingsRadioOption
                selected={scope === 'user'}
                onSelect={() => setScope('user')}
                label="Every project"
              />
              <SettingsRadioOption
                selected={scope === 'project'}
                onSelect={() => setScope('project')}
                disabled={!canUseProject}
                label={`This project only (${folderName(directory)})`}
                description={projectNote}
              />
            </SettingsRadioGroup>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{'Cancel'}</Button>
          <Button variant="solid" size="sm" onClick={confirm}>{'Install'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
