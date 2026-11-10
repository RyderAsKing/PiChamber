import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { MobileServersManager } from '@/apps/MobileServersManager';
import { useDeviceInfo } from '@/lib/device';

/**
 * Servers settings page for the native Capacitor app: the same mobile-backed
 * server list as the quick-access sheet, so phones manage servers in one
 * consistent place. Rendered only on Capacitor (see the `servers` metadata
 * availability); hosted mobile web and plain web never reach this page.
 */
export const MobileServersPage: React.FC<{
  onActiveConnectionDeleted?: () => void;
}> = ({ onActiveConnectionDeleted }) => {
  const { isMobile } = useDeviceInfo();
  return (
    <SettingsPageLayout
      // The phone header already shows the page title.
      title={isMobile ? undefined : 'Servers'}
      description={isMobile ? undefined : 'Which PiChamber server this app uses. Add other servers to switch between them.'}
    >
      <SettingsSection
        title={'Saved servers'}
        info={'Servers this app can connect to. Add a server by address, pairing link, or QR code.'}
        divider={false}
        settingsItem="servers.direct-hosts"
        contentClassName="space-y-4"
      >
        <MobileServersManager
          layout="page"
          onConnect={() => undefined}
          onActiveConnectionDeleted={onActiveConnectionDeleted ?? (() => undefined)}
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
};
