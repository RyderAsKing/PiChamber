import React from 'react';

import type { NativePluginUi, TurnArtifactProps } from './types';

/**
 * Native plugin UI halves. Components load on first use so plugins add
 * nothing to the startup bundle.
 */
const NATIVE_PLUGIN_UIS: readonly NativePluginUi[] = [
  {
    id: 'visuals',
    features: [
      'Draws each page in the chat, between the agent\'s steps and its reply',
      'Page and code views, with copy, download, and full-window view',
      'Shows variants at full width, one at a time, when the agent asks you to pick one, with a note for your choice',
    ],
    turnArtifacts: {
      render_html: React.lazy(() => import('./visuals/VisualsArtifact')),
      render_choices: React.lazy(() => import('./visuals/ChoicesArtifact')),
    },
  },
  {
    id: 'subagents',
    features: [
      'Shows each sub-agent in the chat as a card with its model and progress',
      'Opens any sub-agent on its own in the Agents panel, with its steps and answer',
    ],
    turnArtifacts: {
      subagent: React.lazy(() => import('./subagents/SubagentsArtifact')),
    },
  },
];

const turnArtifactsByTool = new Map<string, React.ComponentType<TurnArtifactProps>>();
for (const ui of NATIVE_PLUGIN_UIS) {
  for (const [toolName, component] of Object.entries(ui.turnArtifacts ?? {})) {
    if (!turnArtifactsByTool.has(toolName)) turnArtifactsByTool.set(toolName, component);
  }
}

/** The `turn.artifacts` component for a tool, if a native plugin draws it. */
export const getTurnArtifact = (toolName: string | undefined): React.ComponentType<TurnArtifactProps> | null => (
  toolName ? turnArtifactsByTool.get(toolName) ?? null : null
);

/** What a native plugin shows in PiChamber, for its Settings page. */
export const getNativePluginFeatures = (uiId: string | undefined): string[] => (
  NATIVE_PLUGIN_UIS.find((ui) => ui.id === uiId)?.features ?? []
);
