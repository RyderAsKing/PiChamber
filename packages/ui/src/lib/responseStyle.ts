import { runtimeFetch } from './runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';
import type { PiSessionStoreState } from '@/sync/pi-session-store-types';

export const RESPONSE_STYLE_PRESETS = ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer'] as const;
export type ResponseStylePreset = typeof RESPONSE_STYLE_PRESETS[number];

export const isResponseStylePreset = (value: unknown): value is ResponseStylePreset => (
  typeof value === 'string' && RESPONSE_STYLE_PRESETS.includes(value as ResponseStylePreset)
);

export const getResponseStylePresetInstructions = (preset: ResponseStylePreset): string => {
  switch (preset) {
    case 'concise':
      return "Keep replies short. Answer first, no preamble or recap of the question. Write like you're texting a colleague who already has the context — plain sentences, not headings or bullets. Reach for a list only when the content is genuinely a list; never use one to look organised.";
    case 'detailed':
      return "Take the space you need to actually explain things. Walk through what's going on, why it matters, and where the real tradeoffs are. Prefer flowing prose over bullet points and headings — structure the answer with paragraphs and let the reasoning carry it. Lists are fine when something really is enumerable, but don't fragment a normal explanation into bullets.";
    case 'mentor':
      return "Talk like a patient senior engineer pairing with someone less experienced. Explain the underlying idea before the answer, think out loud about how you'd approach it, and drop in a small concrete example when it actually helps. Keep it conversational — no lecture format, no checklists, no numbered steps unless the task literally is a sequence.";
    case 'pushback':
      return "Don't agree automatically. If something I say sounds off — a wrong assumption, a flawed approach, a request that won't actually do what I think it will — push back first. Explain what you disagree with and why, and only proceed once I've responded. Disagreement is welcome; sycophancy is not. Don't soften it with 'you might want to consider' — just say it.";
    case 'noFiller':
      return "Cut the filler. No 'Great question', no 'Certainly', no 'I'll help you with that', no restating what I just asked. No closing summary of what you did when the diff or output already shows it. No trailing 'let me know if you need anything else'. Open with the actual content and stop when you're done.";
    case 'matchEnergy':
      return "Mirror the size and register of my message. A one-line question gets a one-line answer. A casual aside gets a casual reply, not a structured breakdown. If I write three words, don't respond with three paragraphs. Match the tone too — informal stays informal, technical stays technical. Don't inflate small asks into full essays.";
    case 'warmPeer':
      return "Talk like a colleague, not an assistant. First person is fine and encouraged — 'I'd do this', 'I don't love that approach', 'that was sloppy of me'. Have actual opinions and share them. Push back when you disagree. Admit when you screwed up without grovelling. Skip the corporate helpfulness and performative politeness — just be a person.";
  }
};

type ResponseStyleSettings = {
  responseStyleEnabled?: unknown;
  responseStylePreset?: unknown;
  responseStyleCustomInstructions?: unknown;
};

const buildResponseStyleInstruction = ({
  enabled,
  preset,
  customInstructions,
}: {
  enabled?: boolean;
  preset?: unknown;
  customInstructions?: unknown;
}): string | null => {
  if (!enabled) return null;
  if (preset === 'custom') {
    const custom = typeof customInstructions === 'string' ? customInstructions.trim() : '';
    return custom || null;
  }
  if (!isResponseStylePreset(preset)) return null;
  return getResponseStylePresetInstructions(preset);
};

/**
 * Response-style injection is a first-user-prompt behavior, so an existing
 * session qualifies only when its transcript evidence is authoritative,
 * complete, and free of earlier user messages:
 *
 * - `hydratedSessionIds` marks the transcript as loaded from the daemon; an
 *   unknown/cold reducer is never proof of a first prompt. Cold sends safely
 *   skip injection until hydration (the selected session hydrates on open,
 *   and `PiSessionStore.prompt()` re-hydrates blank rows before dispatch),
 *   so the composer spends no extra RPC or history download on this gate.
 * - A resident reducer row must exist. A hydrated id without one is an
 *   evicted transcript, not an empty one.
 * - `hasMoreBefore` means the resident tail is one page of a longer history;
 *   a user-free tail is then not proof that no earlier user message exists.
 * - A recorded hydration failure (`sessionLoadErrorById`) leaves transcript
 *   completeness unknown.
 * - Authoritative fresh-empty and extension-only complete histories have no
 *   earlier user message and qualify. Catalog `messageCount` (including the
 *   cached first-paint metadata) and persisted history are never consulted.
 */
const isFirstUserPromptForSession = (
  state: PiSessionStoreState,
  sessionId: string,
): boolean => {
  const resident = state.reducer.bySession.get(sessionId);
  return (
    state.hydratedSessionIds.has(sessionId)
    && !state.sessionLoadErrorById.has(sessionId)
    && resident !== undefined
    && resident.hasMoreBefore !== true
    && ![...resident.messages.values()].some(
      (message) => message.role === 'user',
    )
  );
};

/**
 * Composer gate for one send. New-session drafts always target a session
 * that has no history yet, so they bypass the transcript predicate;
 * existing sessions rely on the authoritative first-prompt predicate.
 */
export const shouldInjectResponseStyle = (input: {
  newSessionDraftOpen: boolean;
  sessionId: string | null;
  storeState: PiSessionStoreState;
}): boolean =>
  input.newSessionDraftOpen
  || (input.sessionId !== null
    ? isFirstUserPromptForSession(input.storeState, input.sessionId)
    : false);

const instructionFromSettings = (settings: ResponseStyleSettings): string | null =>
  buildResponseStyleInstruction({
    enabled: settings.responseStyleEnabled === true,
    preset: settings.responseStylePreset,
    customInstructions: settings.responseStyleCustomInstructions,
  });

let cachedInstruction: { runtimeKey: string; value: string | null } | null = null;
let instructionInflight: { runtimeKey: string; promise: Promise<string | null> } | null = null;

const updateCachedInstruction = (settings: ResponseStyleSettings): void => {
  cachedInstruction = {
    runtimeKey: getRuntimeKey(),
    value: instructionFromSettings(settings),
  };
};

if (typeof window !== 'undefined') {
  window.addEventListener('pichamber:settings-synced', (event) => {
    updateCachedInstruction((event as CustomEvent<ResponseStyleSettings>).detail ?? {});
  });
}

subscribeRuntimeEndpointChanged((detail) => {
  if (detail.runtimeKey === detail.previousRuntimeKey) return;
  cachedInstruction = null;
  instructionInflight = null;
});

export const fetchResponseStyleInstruction = async (): Promise<string | null> => {
  const runtimeKey = getRuntimeKey();
  if (cachedInstruction?.runtimeKey === runtimeKey) return cachedInstruction.value;
  if (instructionInflight?.runtimeKey === runtimeKey) return instructionInflight.promise;

  const request = (async () => {
    const response = await runtimeFetch('/api/pi/ui-settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const settings = await response.json().catch(() => null) as ResponseStyleSettings | null;
    if (!settings || getRuntimeKey() !== runtimeKey) return null;
    const value = instructionFromSettings(settings);
    cachedInstruction = { runtimeKey, value };
    return value;
  })();
  instructionInflight = { runtimeKey, promise: request };
  try {
    return await request;
  } finally {
    if (instructionInflight?.promise === request) instructionInflight = null;
  }
};

/**
 * Send-preparation boundary for one response-style injection: evaluate the
 * first-prompt gate on the captured send target, await the runtime-scoped
 * settings fetch, then re-check the same captured session's eligibility so a
 * first user message committed while the fetch was in flight (another send
 * or a remote event) is not injected twice. New-session drafts skip the
 * re-check: their captured session does not exist until materialization.
 * A runtime switch resolves the fetch to null, and the captured-target
 * dispatch is separately rejected by the runtime guard in `sendMessage`.
 */
export const resolveResponseStyleInstruction = async (input: {
  newSessionDraftOpen: boolean;
  sessionId: string | null;
  getStoreState: () => PiSessionStoreState;
}): Promise<string | null> => {
  if (
    !shouldInjectResponseStyle({
      newSessionDraftOpen: input.newSessionDraftOpen,
      sessionId: input.sessionId,
      storeState: input.getStoreState(),
    })
  ) {
    return null;
  }
  const instruction = await fetchResponseStyleInstruction().catch(() => null);
  if (!instruction) return null;
  if (
    !input.newSessionDraftOpen
    && input.sessionId !== null
    && !isFirstUserPromptForSession(input.getStoreState(), input.sessionId)
  ) {
    return null;
  }
  return instruction;
};
