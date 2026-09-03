import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { TooltipContent } from '@/components/ui/tooltip';
import { formatDate, formatKnowledge } from '../modelControlsMetadata';

export const IconBadge: React.FC<{ iconName: IconName; label: string }> = ({ iconName, label }) => (
  <span
    className="flex size-5 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
    title={label}
    aria-label={label}
    role="img"
  >
    <Icon name={iconName} className="size-3.5" />
  </span>
);

export interface ModelTooltipContentProps {
  currentMetadata?: {
    name?: string;
    knowledge?: string;
    release_date?: string;
  } | null;
  modelDisplayName: string;
  providerDisplayName: string;
  currentCapabilityIcons: Array<{ key: string; icon: IconName; label: string }>;
  inputModalityIcons: Array<{ key: string; icon: IconName; label: string }>;
  outputModalityIcons: Array<{ key: string; icon: IconName; label: string }>;
  costRows: Array<{ label: string; value: string }>;
  limitRows: Array<{ label: string; value: string }>;
}

export const ModelTooltipContent: React.FC<ModelTooltipContentProps> = ({
  currentMetadata,
  modelDisplayName,
  providerDisplayName,
  currentCapabilityIcons,
  inputModalityIcons,
  outputModalityIcons,
  costRows,
  limitRows,
}) => {
  return (
    <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
      {currentMetadata ? (
        <div className="flex min-w-[240px] flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="typography-micro font-semibold text-foreground">
              {currentMetadata.name || modelDisplayName}
            </span>
            <span className="typography-meta text-muted-foreground">{providerDisplayName}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
              Capabilities
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {currentCapabilityIcons.length > 0 ? (
                currentCapabilityIcons.map(({ key, icon, label }) => (
                  <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                ))
              ) : (
                <span className="typography-meta text-muted-foreground">—</span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
              Modalities
            </span>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="typography-meta font-medium text-muted-foreground/80">Input</span>
                <div className="flex items-center gap-1.5">
                  {inputModalityIcons.length > 0 ? (
                    inputModalityIcons.map(({ key, icon, label }) => (
                      <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />
                    ))
                  ) : (
                    <span className="typography-meta text-muted-foreground">-</span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="typography-meta font-medium text-muted-foreground/80">Output</span>
                <div className="flex items-center gap-1.5">
                  {outputModalityIcons.length > 0 ? (
                    outputModalityIcons.map(({ key, icon, label }) => (
                      <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />
                    ))
                  ) : (
                    <span className="typography-meta text-muted-foreground">-</span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
              Cost ($/1M tokens)
            </span>
            {costRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3">
                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                <span className="typography-meta font-medium text-foreground">{row.value}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
              Limits
            </span>
            {limitRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3">
                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                <span className="typography-meta font-medium text-foreground">{row.value}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">
              Metadata
            </span>
            <div className="flex items-center justify-between gap-3">
              <span className="typography-meta font-medium text-muted-foreground/80">Knowledge</span>
              <span className="typography-meta font-medium text-foreground">
                {formatKnowledge(currentMetadata.knowledge)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="typography-meta font-medium text-muted-foreground/80">Release</span>
              <span className="typography-meta font-medium text-foreground">
                {formatDate(currentMetadata.release_date)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-w-[200px] typography-meta text-muted-foreground">
          Model metadata unavailable.
        </div>
      )}
    </TooltipContent>
  );
};
