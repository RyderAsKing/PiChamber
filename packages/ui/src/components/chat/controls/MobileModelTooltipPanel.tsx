import React from 'react';

import type { IconName } from '@/components/icon/icons';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { formatDate, formatKnowledge, formatTokens } from '../modelControlsMetadata';
import { IconBadge } from './ModelTooltipContent';

export interface MobileModelTooltipPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  providerDisplayName: string;
  currentCapabilityIcons: Array<{ key: string; icon: IconName; label: string }>;
  inputModalityIcons: Array<{ key: string; icon: IconName; label: string }>;
  outputModalityIcons: Array<{ key: string; icon: IconName; label: string }>;
  currentMetadata?: {
    limit?: { context?: number; output?: number };
    knowledge?: string;
    release_date?: string;
  } | null;
}

export const MobileModelTooltipPanel: React.FC<MobileModelTooltipPanelProps> = ({
  open,
  onClose,
  title,
  providerDisplayName,
  currentCapabilityIcons,
  inputModalityIcons,
  outputModalityIcons,
  currentMetadata,
}) => {
  if (!open) return null;

  return (
    <MobileOverlayPanel open={true} onClose={onClose} title={title}>
      <div className="flex flex-col gap-1.5">
        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
          <div className="typography-micro text-muted-foreground mb-0.5">Provider</div>
          <div className="typography-meta text-foreground font-medium">{providerDisplayName}</div>
        </div>

        {currentCapabilityIcons.length > 0 && (
          <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
            <div className="typography-micro text-muted-foreground mb-1">Capabilities</div>
            <div className="flex flex-wrap gap-1.5">
              {currentCapabilityIcons.map(({ key, icon, label }) => (
                <div key={key} className="flex items-center gap-1.5">
                  <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                  <span className="typography-meta text-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
          <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
            <div className="typography-micro text-muted-foreground mb-1">Modalities</div>
            <div className="flex flex-col gap-1">
              {inputModalityIcons.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="typography-meta text-muted-foreground/80 w-12">Input</span>
                  <div className="flex gap-1">
                    {inputModalityIcons.map(({ key, icon, label }) => (
                      <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />
                    ))}
                  </div>
                </div>
              )}
              {outputModalityIcons.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="typography-meta text-muted-foreground/80 w-12">Output</span>
                  <div className="flex gap-1">
                    {outputModalityIcons.map(({ key, icon, label }) => (
                      <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
          <div className="typography-micro text-muted-foreground mb-1">Limits</div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <span className="typography-meta text-muted-foreground/80">Context</span>
              <span className="typography-meta font-medium text-foreground">
                {formatTokens(currentMetadata?.limit?.context)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="typography-meta text-muted-foreground/80">Output</span>
              <span className="typography-meta font-medium text-foreground">
                {formatTokens(currentMetadata?.limit?.output)}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
          <div className="typography-micro text-muted-foreground mb-1">Metadata</div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <span className="typography-meta text-muted-foreground/80">Knowledge</span>
              <span className="typography-meta font-medium text-foreground">
                {formatKnowledge(currentMetadata?.knowledge)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="typography-meta text-muted-foreground/80">Release</span>
              <span className="typography-meta font-medium text-foreground">
                {formatDate(currentMetadata?.release_date)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </MobileOverlayPanel>
  );
};
