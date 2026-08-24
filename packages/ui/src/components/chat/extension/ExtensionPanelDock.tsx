import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import {
  PI_EXTENSION_UI_PROTOCOL,
  PI_EXTENSION_UI_VERSION,
} from '@/lib/pi/extension-ui';
import { ExtensionMessageCard } from '../message/parts/extension/ExtensionMessageCard';

/**
 * Live declarative extension panels (`pichamber.ui` entries mirrored into
 * normalized `extension.ui` events). Latest wins per stable id, so an
 * extension reporting progress updates one panel instead of stacking
 * transcript cards. History rows still exist in the transcript; this dock is
 * the authoritative live surface and survives reconnects via snapshots.
 */
export const ExtensionPanelDock: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const panels = usePiSessionSnapshot(
    (state) => (
      activeSessionId
        ? [...(state.reducer.bySession.get(activeSessionId)?.extensionPanels.values() ?? [])]
        : []
    ),
    (a, b) => (
      a.length === b.length && a.every((panel, index) => {
        const other = b[index];
        return Boolean(other)
          && panel.id === other?.id
          && panel.title === other.title
          && JSON.stringify(panel.props ?? null) === JSON.stringify(other.props ?? null);
      })
    ),
    `session:${activeSessionId ?? ''}`,
  );

  if (!activeSessionId || panels.length === 0) return null;

  return (
    <div className="chat-input-column" data-testid="extension-panel-dock">
      <div className="flex flex-col gap-3">
        {panels.map((panel) => (
          <ExtensionMessageCard
            key={panel.id}
            sessionId={activeSessionId}
            messageId={`extension-panel-${panel.id}`}
            customType="pichamber.ui"
            data={{
              protocol: PI_EXTENSION_UI_PROTOCOL,
              version: PI_EXTENSION_UI_VERSION,
              ...panel,
            }}
            className="my-0 border-border/60 shadow-sm"
          />
        ))}
      </div>
    </div>
  );
};
