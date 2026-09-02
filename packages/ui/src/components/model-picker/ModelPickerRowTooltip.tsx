import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import type { ModelMetadata } from '@/types';

export const formatCompactNumber = (value: number) => new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

export const formatUsdCurrency = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
}).format(value);

export const getModelDisplayName = (model: Record<string, unknown>) => {
  return getSharedModelDisplayName(model, undefined, { maxLength: 40 });
};

export const formatModelContextTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

export const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatUsdCurrency(value);
};

export const hasTooltipMetadata = (metadata?: ModelMetadata) => {
  if (!metadata) return false;
  return Boolean(
    metadata.tool_call ||
    metadata.reasoning ||
    metadata.cost?.input !== undefined ||
    metadata.cost?.output !== undefined ||
    (metadata.modalities?.input?.length ?? 0) > 0 ||
    (metadata.modalities?.output?.length ?? 0) > 0,
  );
};

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
