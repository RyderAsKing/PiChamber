import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { MobileServersManager } from '@/apps/MobileServersManager';

/**
 * Servers settings page for the native Capacitor app: the same mobile-backed
 * server list as the quick-access sheet, so phones manage servers in one
 * consistent place. Rendered only on Capacitor (see the `servers` metadata
 * availability); hosted mobile web and plain web never reach this page.
 */
export const MobileServersPage: React.FC<{
  onActiveConnectionDeleted?: () => void;
}> = ({ onActiveConnectionDeleted }) => {
  return (
    <SettingsPageLayout
      title="Servers"
      description="Which PiChamber server this app uses. Add other servers to switch between them."
    >
      <SettingsSection
        title={'Other PiChamber servers'}
        info={'Servers this app can connect to. Add a server by address, pairing link, or QR code.'}
        divider={false}
        settingsItem="servers.direct-hosts"
        contentClassName="space-y-4"
      >
        <MobileServersManager
          onConnect={() => undefined}
          onActiveConnectionDeleted={onActiveConnectionDeleted ?? (() => undefined)}
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
};
