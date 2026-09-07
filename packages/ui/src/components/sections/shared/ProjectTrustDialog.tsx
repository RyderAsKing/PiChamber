import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';
import {
  busySettingsMessage,
  deferredSettingsMessage,
  isDeferredPiMutation,
  isSessionBusyError,
} from '@/lib/pi/mutation-status';

/** Resolves Pi's persisted project-resource trust decision before protected resources are shown. */
export const ProjectTrustDialog: React.FC<{ onResolved?: () => void }> = ({ onResolved }) => {
  
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void piClient.getSettings({ runtimeKey: getRuntimeKey() }).then((settings) => {
      if (active) setOpen(settings.pi.project.requiresTrust === true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const decide = async (trust: boolean) => {
    setSaving(true);
    try {
      const result = await piClient.setPiSettings({ scope: 'project', trust }, { runtimeKey: getRuntimeKey() });
      setOpen(false);
      if (isDeferredPiMutation(result)) {
        toast.info(deferredSettingsMessage('Project trust'));
      }
      onResolved?.();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Failed to update project trust';
      if (isSessionBusyError(error)) {
        toast.info(busySettingsMessage('Project trust'));
      } else {
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={open} onOpenChange={() => {}}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{"Trust this project?"}</DialogTitle>
        <DialogDescription>{"This project contains Pi settings, skills, prompts, or extensions. Trusting it allows Pi to load those project resources."}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => void decide(false)}>{"Keep untrusted"}</Button>
        <Button size="sm" disabled={saving} onClick={() => void decide(true)}>{"Trust project"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
};
