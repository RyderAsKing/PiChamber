import type React from 'react';

import type { ToolPart } from '@/lib/chat/types';

/** Props every `turn.artifacts` component receives. */
export interface TurnArtifactProps {
  part: ToolPart;
  /** Directory of the session the turn belongs to, when known. */
  directory: string | null;
}

/**
 * The UI half of a native plugin, compiled into the app.
 * Every field is a slot the plugin adds to; none replaces a built-in control.
 */
export interface NativePluginUi {
  /** Matches the manifest's `pichamber.ui`. */
  id: string;
  /** What the plugin shows in PiChamber, one short line each, for its Settings page. */
  features?: string[];
  /**
   * `turn.artifacts`: drawn between a turn's activity and its reply, one per
   * tool call, keyed by tool name.
   */
  turnArtifacts?: Record<string, React.ComponentType<TurnArtifactProps>>;
}
