import type React from 'react';

import type { ToolPart } from '@/lib/chat/types';
import type { PiExtensionChoice } from '@/lib/pi/protocol';

/**
 * A question the plugin's tool call is waiting on (`pichamber.ui.choose` with the
 * call's `toolCallId`). The component may draw it its own way; the dock
 * above the composer shows the same question, so either can answer.
 */
export interface PluginQuestion {
  requestId: string;
  title: string;
  message?: string;
  choices: PiExtensionChoice[];
  /** Whether `answer` may carry a note. */
  allowNote: boolean;
  /** Rejects when the answer could not be sent; the question then stays open. */
  answer: (choiceId: string, note?: string) => Promise<void>;
  /** Close the question without an answer. */
  dismiss: () => Promise<void>;
}

/** Props every `turn.artifacts` component receives. */
export interface TurnArtifactProps {
  part: ToolPart;
  /** Directory of the session the turn belongs to, when known. */
  directory: string | null;
  /** Set only while this tool call waits on a question, from the live session. */
  question?: PluginQuestion;
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
