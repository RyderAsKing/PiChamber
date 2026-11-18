import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsDisclosure,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import type { PiSandboxProfile } from '@/lib/pi/protocol';

interface SandboxProfileFieldsProps {
  profile: PiSandboxProfile;
  saving: boolean;
  /** Why the last save or reset was refused. */
  errors: string[];
  onSave: (content: string) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

/**
 * The nono profile every sandboxed project on this server runs under: where
 * the file is, and, for an owner who needs more than the per-project hosts,
 * ports and folders, a custom copy to edit here or on disk. Rarely needed,
 * so it sits in a disclosure at the end of Sandboxing.
 */
export const SandboxProfileFields: React.FC<SandboxProfileFieldsProps> = ({ profile, saving, errors, onSave, onReset }) => {
  const [text, setText] = React.useState(profile.content);
  const [confirmingReset, setConfirmingReset] = React.useState(false);
  // Take the server's text whenever it changes (load, save, reset, an edit
  // on disk). The same text arriving again leaves what is being typed alone.
  React.useEffect(() => {
    setText(profile.content);
  }, [profile.content]);

  const changed = text !== profile.content;

  return (
    <SettingsDisclosure label="Sandbox profile" divider={false} className="pb-0 pt-2">
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <p className={cn(SETTINGS_HELPER_CLASS, 'max-w-[44rem] text-pretty')}>
          The profile is nono&apos;s policy for every sandboxed project on this server: which system folders and
          runtimes an agent can read, and the rules for signals and sockets. Project folders, allowed hosts and
          local ports are added for each project and are not in this file.
        </p>

        <div className="min-w-0 space-y-0.5">
          <p className={SETTINGS_FIELD_LABEL_CLASS}>{profile.custom ? 'Custom profile' : 'Built-in profile'}</p>
          <p className="typography-meta select-text break-all font-mono text-muted-foreground">{profile.path}</p>
        </div>

        {profile.unreadable ? (
          <p className="typography-meta text-[var(--status-error)]" role="status">
            The custom profile could not be read, so sandboxed projects do not run. Fix the file on the server
            machine, or reset to the built-in profile.
          </p>
        ) : profile.custom ? (
          <>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="Custom sandbox profile, JSON"
              rows={16}
              spellCheck={false}
              className="min-h-0 max-w-[44rem] font-mono"
              disabled={saving}
            />
            <p className={cn(SETTINGS_HELPER_CLASS, 'max-w-[44rem] text-pretty')}>
              <span className="text-[var(--status-warning)]">A looser profile weakens every sandboxed project on this server.</span>
              {' '}Saving checks the profile with nono, then restarts running sandboxes after their current turn. You
              can also edit the file on the server machine. A custom profile no longer follows updates to the
              built-in one.
            </p>
          </>
        ) : (
          <p className={cn(SETTINGS_HELPER_CLASS, 'max-w-[44rem] text-pretty')}>
            Customising copies this profile to PiChamber&apos;s data folder, where sandboxed code cannot write, and
            uses the copy instead. You can then edit it here or on the server machine.
          </p>
        )}

        {errors.length > 0 ? (
          <div role="alert" className="max-w-[44rem] space-y-1">
            {errors.map((error) => (
              <p key={error} className="typography-meta break-words text-[var(--status-error)]">{error}</p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {!profile.custom ? (
            <Button variant="outline" size="xs" disabled={saving} onClick={() => void onSave(profile.content)}>
              {saving ? 'Saving…' : 'Customise'}
            </Button>
          ) : confirmingReset ? (
            <>
              <Button
                variant="destructive"
                size="xs"
                disabled={saving}
                onClick={() => void onReset().then(() => setConfirmingReset(false))}
              >
                Delete custom profile
              </Button>
              <Button variant="outline" size="xs" disabled={saving} onClick={() => setConfirmingReset(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {!profile.unreadable ? (
                <Button variant="outline" size="xs" disabled={saving || !changed} onClick={() => void onSave(text)}>
                  {saving ? 'Saving…' : 'Save profile'}
                </Button>
              ) : null}
              <Button variant="outline" size="xs" disabled={saving} onClick={() => setConfirmingReset(true)}>
                Reset to default
              </Button>
            </>
          )}
        </div>
      </div>
    </SettingsDisclosure>
  );
};
