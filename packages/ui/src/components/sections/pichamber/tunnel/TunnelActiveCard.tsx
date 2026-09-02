import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TunnelInfo, TunnelMode } from './tunnelTypes';

export interface TunnelActiveCardProps {
  tunnelInfo: TunnelInfo;
  isConnectLinkLive: boolean;
  copied: boolean;
  onCopyUrl: () => void;
  remainingText: string;
  qrDataUrl: string | null;
  onNewConnectLink: () => void;
  onStop: () => void;
  stopping: boolean;
  isSavingMode: boolean;
  isManagedLocalConfigPathInvalid: boolean;
  tunnelMode: TunnelMode;
  primaryCtaClass: string;
}

export const TunnelActiveCard: React.FC<TunnelActiveCardProps> = ({
  tunnelInfo,
  isConnectLinkLive,
  copied,
  onCopyUrl,
  remainingText,
  qrDataUrl,
  onNewConnectLink,
  onStop,
  stopping,
  isSavingMode,
  isManagedLocalConfigPathInvalid,
  tunnelMode,
  primaryCtaClass,
}) => {
  return (
    <section data-settings-item="tunnel.start" className="space-y-4 px-2 pb-2 pt-0">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="size-2 shrink-0 rounded-full bg-[var(--status-success)]" />
          <p className="typography-meta font-medium text-foreground">{'Tunnel ready'}</p>
        </div>

        <div>
          <p className="typography-meta mb-1 text-muted-foreground/70">
            {'Public URL (not accessible without a token)'}
          </p>
          <code className="typography-code block truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
            {tunnelInfo.url}
          </code>
        </div>

        {isConnectLinkLive && tunnelInfo.connectUrl && (
          <>
            <div>
              <p className="typography-meta mb-1 text-muted-foreground/70">
                {'Connect link'}
              </p>
              <div className="flex items-center gap-2">
                <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                  {tunnelInfo.connectUrl}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onCopyUrl}
                  className="shrink-0 gap-1.5"
                >
                  {copied ? (
                    <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                  ) : (
                    <Icon name="file-copy" className="size-3.5" />
                  )}
                  {copied ? 'Copied' : 'Copy all'}
                </Button>
              </div>
              <p className="typography-meta mt-1 text-muted-foreground/70">
                {'Expires'}: {tunnelInfo.bootstrapExpiresAt ? remainingText : 'Never'}
              </p>
            </div>

            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 bg-[var(--surface-elevated)] p-4">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={'Tunnel connect QR code'}
                  className="size-48"
                />
              ) : (
                <div className="size-48 rounded bg-muted/30" />
              )}
              <p className="typography-meta text-muted-foreground">
                {'Scan with your phone to connect.'}
              </p>
            </div>
          </>
        )}
      </div>

      <div className="pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onNewConnectLink}
            disabled={
              stopping ||
              isSavingMode ||
              (tunnelMode === 'managed-local' && isManagedLocalConfigPathInvalid)
            }
            className={primaryCtaClass}
          >
            <Icon name="restart" className="size-3.5" />
            {'New connect link'}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={onStop}
            disabled={stopping || isSavingMode}
            className="gap-2 text-[var(--status-error)]"
          >
            {stopping ? (
              <>
                <Icon name="loader-4" className="size-3.5 animate-spin" />{' '}
                {'Stopping...'}
              </>
            ) : (
              'Stop Tunnel'
            )}
          </Button>
        </div>
      </div>
    </section>
  );
};
