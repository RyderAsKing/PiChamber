import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { clearServerBrowserData } from '@/lib/serverBrowser/api';
import { useUIStore, type ChatLinkTarget } from '@/stores/useUIStore';

const LINK_TARGET_OPTIONS: Array<{ value: ChatLinkTarget; label: string }> = [
  { value: 'system', label: 'System browser' },
  { value: 'pichamber', label: 'PiChamber browser' },
];

/** Settings for the PiChamber browser: where chat links open and its saved data. */
export const BrowserSettings: React.FC = () => {
  const chatLinkTarget = useUIStore((state) => state.chatLinkTarget);
  const setChatLinkTarget = useUIStore((state) => state.setChatLinkTarget);
  const [confirming, setConfirming] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const clear = async () => {
    setClearing(true);
    try {
      await clearServerBrowserData();
      toast.success('Browsing data cleared');
      setConfirming(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not clear browsing data');
    } finally {
      setClearing(false);
    }
  };

  return (
    <SettingsSection title="Web browser">
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow
          settingsItem="general.chat-link-target"
          label="Open chat links in"
          info="Applies to a plain click. Cmd-click, Ctrl-click, and middle-click still use the system browser."
        >
          <SettingsChipGroup value={chatLinkTarget} onChange={setChatLinkTarget} options={LINK_TARGET_OPTIONS} />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="general.browser-data"
          label="Browsing data"
          info="Pages loaded through the server keep their cookies and sign-ins on the server, shared by every device."
        >
          {confirming ? (
            <div className="flex flex-col gap-2">
              <p className={`${SETTINGS_HELPER_CLASS} max-w-sm [text-wrap:pretty]`}>
                {'This signs you out of every site in the server browser. Pages open on any device reload, signed out.'}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" disabled={clearing} onClick={() => void clear()}>
                  {'Clear browsing data'}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={clearing} onClick={() => setConfirming(false)}>
                  {'Cancel'}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
              {'Clear'}
            </Button>
          )}
        </SettingsFieldRow>
      </div>
    </SettingsSection>
  );
};
