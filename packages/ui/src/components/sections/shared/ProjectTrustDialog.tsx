import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';

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
      await piClient.setPiSettings({ scope: 'project', trust }, { runtimeKey: getRuntimeKey() });
      setOpen(false);
      onResolved?.();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Failed to update project trust';
      const isBusy = message.includes('SESSION_BUSY') || (error as { code?: string })?.code === 'SESSION_BUSY';
      toast.error(isBusy ? 'Project trust cannot change while a session is streaming. Wait for the response to finish and try again.' : message);
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
