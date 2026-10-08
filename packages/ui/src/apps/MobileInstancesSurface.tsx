import React from 'react';

import { MobileServersManager } from './MobileServersManager';

/**
 * Quick-access servers sheet (Capacitor sidebar entry). The component name
 * keeps the historical `Instances` identifier; all user-facing copy reads
 * "Servers". Management UI lives in `MobileServersManager`, shared with the
 * mobile servers settings page.
 */
export const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => {
  return (
    <MobileServersManager
      onConnect={onConnect}
      onActiveConnectionDeleted={onActiveConnectionDeleted}
      showDiagnostics
    />
  );
};
