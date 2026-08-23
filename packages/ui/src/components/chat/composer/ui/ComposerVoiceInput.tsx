import React from 'react';

import { Button } from '@/components/ui/button';
import type { DictationState } from '@/lib/dictation/dictation-state';
import { ComposerVoiceVisualizer } from './ComposerVoiceVisualizer';

interface ComposerVoiceInputProps {
  state: DictationState;
  elapsedSeconds: number;
  subscribeLevel(listener: (level: number) => void): () => void;
  onCancel(): void;
  onDone(): void;
}

const elapsed = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

export function ComposerVoiceInput({ state, elapsedSeconds, subscribeLevel, onCancel, onDone }: ComposerVoiceInputProps) {
  const recording = state === 'recording' || state === 'reconnecting';
  const status = state === 'requesting-permission'
    ? 'Requesting microphone access...'
    : state === 'reconnecting'
      ? 'Recording. Reconnecting to the server...'
      : state === 'transcribing'
        ? 'Transcribing...'
        : 'Recording';

  return (
    <div className="flex min-h-[7rem] items-center gap-3 px-3 py-3" role="group" aria-label="Dictation recorder">
      <div className="min-w-0 flex-1">
        {recording ? <ComposerVoiceVisualizer subscribeLevel={subscribeLevel} /> : (
          <div className="flex h-12 items-center justify-center typography-ui-label text-muted-foreground">{status}</div>
        )}
        <div className="flex items-center justify-center gap-2 typography-ui-compact text-muted-foreground">
          {recording ? <span className="size-2 rounded-full bg-[var(--status-error)]" aria-hidden="true" /> : null}
          <span className="tabular-nums">{elapsed(elapsedSeconds)}</span>
        </div>
        <span className="sr-only" role="status" aria-live="polite">{status}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={onDone} disabled={!recording}>Done</Button>
      </div>
    </div>
  );
}
