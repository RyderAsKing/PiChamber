import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  catalogThinkingLevels,
  isPiThinkingLevel,
  modelHasConfigurableThinking,
  PI_THINKING_LEVEL_LABELS,
} from '@/lib/pi/thinking';
import type { PiModel, PiThinkingLevel } from '@/lib/pi/types';
import { cn } from '@/lib/utils';
import {
  FALLBACK_THINKING,
  thinkingSelectOptions,
} from './providerModelHelpers';

export type ProviderModel = PiModel & { contextWindow?: number; reasoning?: unknown };

export interface ProviderModelRowProps {
  providerId: string;
  model: ProviderModel;
  storedLevel?: PiThinkingLevel;
  isBusy: boolean;
  isHidden: boolean;
  isConnected: boolean;
  onThinkingChange: (providerId: string, modelId: string, level: PiThinkingLevel | null) => void;
  onToggleHidden: (providerId: string, modelId: string) => void;
}

export const ProviderModelRow = React.memo<ProviderModelRowProps>(
  ({ providerId, model, storedLevel, isBusy, isHidden, isConnected, onThinkingChange, onToggleHidden }) => {
    const levels = React.useMemo(() => catalogThinkingLevels(model), [model]);
    const hasConfigurable = React.useMemo(() => modelHasConfigurableThinking(levels), [levels]);
    const showThinking = hasConfigurable || storedLevel !== undefined;
    const options = React.useMemo(() => thinkingSelectOptions(levels, storedLevel), [levels, storedLevel]);
    const selectValue = storedLevel ?? FALLBACK_THINKING;

    return (
      <div className={cn('flex min-w-0 items-center gap-2 py-2', isHidden && 'opacity-60')}>
        <span className="min-w-0 flex-1 truncate typography-ui-label">{model.label || model.id}</span>
        {showThinking ? (
          <Select
            value={selectValue}
            onValueChange={(value) =>
              onThinkingChange(providerId, model.id, value === FALLBACK_THINKING ? null : (value as PiThinkingLevel))
            }
            disabled={isBusy}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-[4.5rem] max-w-[8rem] shrink-0 border-0 bg-transparent px-1.5 shadow-none gap-1 text-muted-foreground hover:bg-muted hover:text-foreground data-[placeholder]:text-muted-foreground"
              aria-label={`Thinking for ${model.label || model.id}`}
            >
              <SelectValue>
                {(value) => {
                  if (value === FALLBACK_THINKING) return 'Default';
                  if (value && isPiThinkingLevel(value)) return PI_THINKING_LEVEL_LABELS[value];
                  return (value as string) ?? '';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FALLBACK_THINKING}>Default</SelectItem>
              {options.map((level) => (
                <SelectItem key={level} value={level}>
                  {PI_THINKING_LEVEL_LABELS[level]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {model.supportsThinking ? (
          <Icon name="brain-ai-3" className="size-4 shrink-0 text-muted-foreground" aria-label="Reasoning" />
        ) : null}
        {typeof model.contextWindow === 'number' ? (
          <span className="shrink-0 typography-micro text-muted-foreground">{model.contextWindow}</span>
        ) : null}
        {isConnected ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onToggleHidden(providerId, model.id)}
            aria-label={isHidden ? 'Show model in pickers' : 'Hide model from pickers'}
            title={isHidden ? 'Show model in pickers' : 'Hide model from pickers'}
          >
            <Icon name={isHidden ? 'eye' : 'eye-off'} className="size-4" />
          </Button>
        ) : null}
      </div>
    );
  },
);
ProviderModelRow.displayName = 'ProviderModelRow';
