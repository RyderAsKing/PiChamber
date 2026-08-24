import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { DictationState } from '@/lib/dictation/dictation-state';
import { cn } from '@/lib/utils';
import { ComposerVoiceVisualizer } from './ComposerVoiceVisualizer';

interface ComposerVoiceInputProps {
  state: DictationState;
  subscribeLevel(listener: (level: number) => void): () => void;
}

interface ComposerVoiceActionsProps {
  state: DictationState;
  elapsedSeconds: number;
  buttonClassName?: string;
  iconClassName?: string;
  isMobile?: boolean;
  onCancel(): void;
  onDone(): void;
}

const elapsed = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

export function ComposerVoiceActions({ state, elapsedSeconds, buttonClassName, iconClassName, isMobile, onCancel, onDone }: ComposerVoiceActionsProps) {
  const recording = state === 'recording' || state === 'reconnecting';

  return (
    <div className="flex shrink-0 items-center gap-1">
      {!isMobile ? (
        <div className="mr-1 flex items-center gap-2 typography-ui-compact text-muted-foreground">
          {recording ? <span className="size-2 rounded-full bg-[var(--status-error)]" aria-hidden="true" /> : null}
          <span className="tabular-nums">{elapsed(elapsedSeconds)}</span>
        </div>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={onCancel}
        title="Cancel dictation"
        aria-label="Cancel dictation"
      >
        <Icon name="close" className={cn('size-4', iconClassName)} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(buttonClassName, 'text-primary hover:text-primary')}
        onClick={onDone}
        disabled={!recording}
        title="Finish dictation"
        aria-label="Finish dictation"
      >
        <Icon name="check" className={cn('size-4', iconClassName)} />
      </Button>
    </div>
  );
}

export function ComposerVoiceInput({ state, subscribeLevel }: ComposerVoiceInputProps) {
  const recording = state === 'recording' || state === 'reconnecting';
  const status = state === 'requesting-permission'
    ? 'Requesting microphone access...'
    : state === 'reconnecting'
      ? 'Recording. Reconnecting to the server...'
      : state === 'transcribing'
        ? 'Transcribing...'
        : 'Recording';

  return (
    <div className="flex h-[7rem] w-full items-center px-3 py-3" role="group" aria-label="Dictation recorder">
      <div className="min-w-0 flex-1">
        {recording ? <ComposerVoiceVisualizer subscribeLevel={subscribeLevel} /> : (
          <div className="flex h-12 items-center justify-center typography-ui-label text-muted-foreground">{status}</div>
        )}
        <span className="sr-only" role="status" aria-live="polite">{status}</span>
      </div>
    </div>
  );
}
