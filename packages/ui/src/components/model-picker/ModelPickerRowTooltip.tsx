import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ModelMetadata } from '@/types';
import {
  formatCost,
  hasTooltipMetadata,
} from './modelPickerRowHelpers';

export interface ModelPickerRowTooltipLabels {
  capabilityToolCalling?: string;
  capabilityReasoning?: string;
  capabilities?: string;
  input?: string;
  output?: string;
  costPerMillion?: string;
}

export const ModelPickerRowTooltip: React.FC<{
  metadata?: ModelMetadata;
  active: boolean;
  labels: ModelPickerRowTooltipLabels;
  children: React.ReactElement;
}> = ({ metadata, active, labels, children }) => {
  const [delayedActive, setDelayedActive] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setDelayedActive(false);
      return;
    }
    const timeout = window.setTimeout(() => setDelayedActive(true), 450);
    return () => window.clearTimeout(timeout);
  }, [active]);

  if (!hasTooltipMetadata(metadata)) return children;

  const inputModalities = metadata?.modalities?.input ?? [];
  const outputModalities = metadata?.modalities?.output ?? [];
  const capabilities = [
    metadata?.tool_call ? labels.capabilityToolCalling : null,
    metadata?.reasoning ? labels.capabilityReasoning : null,
  ].filter(Boolean);

  return (
    <Tooltip delayDuration={0} open={active && delayedActive} onOpenChange={() => {}}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {active && delayedActive ? (
        <TooltipContent
          side="right"
          align="center"
          sideOffset={8}
          className="z-[999] p-2 typography-micro space-y-1.5 shadow-md border pointer-events-none"
        >
          {capabilities.length > 0 ? (
            <div>
              <span className="text-muted-foreground">{labels.capabilities || 'Capabilities'}: </span>
              <span className="font-medium">{capabilities.join(', ')}</span>
            </div>
          ) : null}
          {inputModalities.length > 0 || outputModalities.length > 0 ? (
            <div className="space-y-0.5">
              {inputModalities.length > 0 ? (
                <div>
                  <span className="text-muted-foreground">{labels.input || 'Input'}: </span>
                  <span className="font-medium">{inputModalities.join(', ')}</span>
                </div>
              ) : null}
              {outputModalities.length > 0 ? (
                <div>
                  <span className="text-muted-foreground">{labels.output || 'Output'}: </span>
                  <span className="font-medium">{outputModalities.join(', ')}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {metadata?.cost?.input !== undefined || metadata?.cost?.output !== undefined ? (
            <div>
              <span className="text-muted-foreground">{labels.costPerMillion || 'Cost / 1M tokens'}: </span>
              <span className="font-medium">
                {formatCost(metadata?.cost?.input)} / {formatCost(metadata?.cost?.output)}
              </span>
            </div>
          ) : null}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
};
