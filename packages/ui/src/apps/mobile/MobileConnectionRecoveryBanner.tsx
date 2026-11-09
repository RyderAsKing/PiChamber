import { Button } from '@/components/ui/button';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';

type MobileConnectionRecoveryBannerState = 'reconnecting' | 'unreachable';

type MobileConnectionRecoveryBannerProps = {
  state: MobileConnectionRecoveryBannerState;
  /** Saved server label; empty when unknown. */
  label: string;
  onRetry: () => void;
  onUseAnotherServer: () => void;
};

/**
 * Status for temporary-unreachable recovery over the retained shell.
 *
 * 'reconnecting' is a passive pill for the first paced retries (resume races,
 * delayed Wi-Fi). 'unreachable' says the saved server cannot be reached from
 * this network and offers a manual retry or a way back to the server list;
 * the recovery controller keeps retrying in the background either way.
 */
export function MobileConnectionRecoveryBanner({
  state,
  label,
  onRetry,
  onUseAnotherServer,
}: MobileConnectionRecoveryBannerProps) {
  const serverName = label.trim() || 'the server';
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px)+10px)] z-40 flex justify-center px-4"
    >
      {state === 'reconnecting' ? (
        <span className="flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-[var(--surface-elevated)] py-1.5 pl-2 pr-3 text-[var(--surface-elevated-foreground)] shadow-sm">
          <PiChamberLogo width={20} height={20} isAnimated />
          <span className="truncate typography-ui-label">{`Reconnecting to ${serverName}…`}</span>
        </span>
      ) : (
        <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-3 text-[var(--surface-elevated-foreground)] shadow-sm">
          <div className="space-y-0.5">
            <p className="truncate typography-ui-label font-medium">{`Can't reach ${serverName}`}</p>
            <p className="typography-meta text-muted-foreground [text-wrap:pretty]">
              {"Its address may only work on another network. Still retrying in the background."}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onUseAnotherServer}>
              {"Use another server"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {"Retry"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
