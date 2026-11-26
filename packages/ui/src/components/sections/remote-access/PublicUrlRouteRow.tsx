import * as React from 'react';

import { RouteAddress, RouteRow, RouteStatusPill } from './RouteRow';
import type { PairingTransportsState } from './usePairingTransportsState';

/**
 * Read-only row for the operator-configured public URL (PICHAMBER_PUBLIC_URL
 * or `serve --public-url`). Shown only while one is set: it is server
 * configuration, so there is nothing to switch here.
 */
export const PublicUrlRouteRow: React.FC<{ state: PairingTransportsState }> = ({ state }) => {
  const publicUrl = state.failed ? null : state.transports?.publicUrl;
  if (!publicUrl) return null;
  return (
    <RouteRow
      id="remote-access-public-url-row"
      icon="cloud"
      title={'Public address'}
      pill={<RouteStatusPill tone="success">{'On'}</RouteStatusPill>}
      description={'Devices pair through this address first. Change it with PICHAMBER_PUBLIC_URL or --public-url on the server.'}
    >
      <RouteAddress url={publicUrl} copyLabel="Copy public address" />
    </RouteRow>
  );
};
