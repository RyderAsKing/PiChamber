import type { PiSessionEvent } from './protocol';
import { applyAssistantTextDelta } from './text-delta';

const STREAM_FRAME_EVENT_NAMES = new Set([
  'assistant.message.delta',
  'assistant.thinking.delta',
  'session.tool.update',
]);

export const isStreamFrameEvent = (event: PiSessionEvent): boolean => STREAM_FRAME_EVENT_NAMES.has(event.name);

type PiDeltaEvent = Extract<PiSessionEvent, { name: 'assistant.message.delta' | 'assistant.thinking.delta' }>;

const asDeltaEvent = (event: PiSessionEvent): PiDeltaEvent | null => (
  event.name === 'assistant.message.delta' || event.name === 'assistant.thinking.delta' ? event : null
);

const canFoldDeltas = (left: PiSessionEvent, right: PiSessionEvent): boolean => {
  const previous = asDeltaEvent(left);
  const next = asDeltaEvent(right);
  if (!previous || !next || previous.name !== next.name || previous.sessionId !== next.sessionId) {
    return false;
  }
  return previous.payload.messageId === next.payload.messageId
    && previous.payload.contentIndex === next.payload.contentIndex
    && (previous.payload.partId ?? '') === (next.payload.partId ?? '');
};

const foldDeltas = (left: PiSessionEvent, right: PiSessionEvent): PiSessionEvent => {
  const previous = asDeltaEvent(left);
  const next = asDeltaEvent(right);
  if (!previous || !next || previous.name !== next.name) return right;
  return {
    ...next,
    payload: {
      ...next.payload,
      delta: applyAssistantTextDelta(previous.payload.delta, next.payload.delta),
    },
  };
};

/** Fold adjacent same-part deltas. Preserves interleaving with other sessions/parts. */
export const foldConsecutiveStreamDeltas = (events: readonly PiSessionEvent[]): PiSessionEvent[] => {
  const folded: PiSessionEvent[] = [];
  for (const event of events) {
    const previous = folded[folded.length - 1];
    if (previous && canFoldDeltas(previous, event)) {
      folded[folded.length - 1] = foldDeltas(previous, event);
    } else {
      folded.push(event);
    }
  }
  return folded;
};

/**
 * DeepSeek-style cadence: token deltas and live tool output flush once per
 * animation frame. Boundary events (start/end/lifecycle) flush any pending
 * stream frames first, then publish immediately so ordering and terminal
 * events stay intact.
 */
export class PiStreamCadence {
  private buffer: PiSessionEvent[] = [];
  private scheduled: 'none' | 'frame' | 'microtask' = 'none';
  private generation = 0;
  private rafId = 0;

  constructor(private readonly publish: (events: readonly PiSessionEvent[]) => void) {}

  push(event: PiSessionEvent): void {
    if (!isStreamFrameEvent(event)) {
      const pending = this.takeBuffer();
      this.publish(foldConsecutiveStreamDeltas([...pending, event]));
      return;
    }
    this.buffer.push(event);
    this.schedule();
  }

  flush(): void {
    const pending = this.takeBuffer();
    if (pending.length === 0) return;
    this.publish(foldConsecutiveStreamDeltas(pending));
  }

  dispose(): void {
    this.flush();
  }

  private takeBuffer(): PiSessionEvent[] {
    this.generation += 1;
    this.scheduled = 'none';
    if (this.rafId && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
    if (this.buffer.length === 0) return [];
    const events = this.buffer;
    this.buffer = [];
    return events;
  }

  private schedule(): void {
    if (this.scheduled !== 'none') return;
    const generation = ++this.generation;
    const publish = () => {
      if (generation !== this.generation) return;
      this.scheduled = 'none';
      this.rafId = 0;
      const pending = this.buffer;
      this.buffer = [];
      if (pending.length === 0) return;
      this.publish(foldConsecutiveStreamDeltas(pending));
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.scheduled = 'frame';
      this.rafId = globalThis.requestAnimationFrame(publish);
      return;
    }
    this.scheduled = 'microtask';
    queueMicrotask(publish);
  }
}
