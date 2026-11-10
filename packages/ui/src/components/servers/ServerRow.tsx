import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
  SERVER_STATUS_META,
  isServerStatusBlocked,
  serverDisplayAddress,
  type ServerListItem,
  type ServerRoute,
  type ServerStatus,
} from '@/lib/servers/serverViewModel';
import {
  resolveDisplayedRoute,
  selectServerRouteByValue,
  serverRouteOptionValue,
} from './serverRouteDisplay';

export type ServerRowHandlers = {
  onSwitch?: (item: ServerListItem) => void;
  onSetDefault?: (item: ServerListItem) => void;
  onOpenInNewWindow?: (item: ServerListItem) => void;
  onEdit?: (item: ServerListItem) => void;
  onRemove?: (item: ServerListItem) => void;
  onSelectRoute?: (item: ServerListItem, route: ServerRoute) => void;
};

export type ServerRowProps = ServerRowHandlers & {
  item: ServerListItem;
  /** Touch-friendly stacked layout for narrow/mobile surfaces. */
  layout?: 'comfortable' | 'touch';
  /** Disable the default star for blocked statuses (switcher rule). */
  guardDefaultByStatus?: boolean;
  /** Label for the switch action; mobile uses "Connect". */
  switchLabel?: string;
  /** A probe cycle is running; show a subtle checking indicator. */
  refreshing?: boolean;
  /** One host is mid-switch; disable actions for it. */
  pending?: boolean;
  /** Persist/delete traffic is in flight; disable every action. */
  actionsDisabled?: boolean;
};

const statusDotClass = (status: ServerStatus, pulse: boolean): string => {
  const tone = SERVER_STATUS_META[status].tone;
  return cn(
    'h-2 w-2 rounded-full flex-shrink-0',
    tone === 'success' && 'bg-status-success',
    tone === 'warning' && 'bg-status-warning',
    tone === 'error' && 'bg-status-error',
    tone === 'info' && 'bg-status-info',
    tone === 'muted' && 'bg-muted-foreground/40',
    pulse && 'animate-pulse',
  );
};

const statusTextClass = (status: ServerStatus, touch: boolean): string => {
  const tone = SERVER_STATUS_META[status].tone;
  return cn(
    touch ? 'typography-meta block truncate' : 'typography-micro truncate',
    tone === 'success' && 'text-[var(--status-success)]',
    tone === 'warning' && 'text-[var(--status-warning)]',
    tone === 'error' && 'text-[var(--status-error)]',
    tone === 'info' && 'text-[var(--status-info)]',
    tone === 'muted' && 'text-muted-foreground',
  );
};

const routeTextClass = 'typography-micro truncate text-muted-foreground';

function ServerRouteText({
  item,
  onSelectRoute,
}: Pick<ServerRowProps, 'item' | 'onSelectRoute'>) {
  const displayed = resolveDisplayedRoute(item);
  if (!displayed) return null;
  const interactive = typeof onSelectRoute === 'function' && item.routes.length > 1;
  if (!interactive) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="shrink-0 text-subtle-foreground">{'·'}</span>
        <span className={routeTextClass}>{displayed.label}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-route-picker=""
            className="inline-flex min-w-0 max-w-full items-center gap-0.5 rounded typography-micro text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Connection route for ${item.label}: ${displayed.label}`}
          >
            <span aria-hidden="true" className="shrink-0 text-subtle-foreground">{'·'}</span>
            <span className="truncate">{displayed.label}</span>
            <Icon name="arrow-down-s" className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" portalToBody>
          <DropdownMenuRadioGroup
            value={serverRouteOptionValue(displayed)}
            onValueChange={(value) => {
              const next = selectServerRouteByValue(item, value);
              if (next) onSelectRoute?.(item, next);
            }}
          >
            {item.routes.map((route) => (
              <DropdownMenuRadioItem
                key={serverRouteOptionValue(route)}
                value={serverRouteOptionValue(route)}
              >
                {route.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export const ServerRow: React.FC<ServerRowProps> = ({
  item,
  layout = 'comfortable',
  guardDefaultByStatus = false,
  switchLabel = 'Switch',
  refreshing = false,
  pending = false,
  actionsDisabled = false,
  onSwitch,
  onSetDefault,
  onOpenInNewWindow,
  onEdit,
  onRemove,
  onSelectRoute,
}) => {
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  React.useEffect(() => {
    setConfirmingRemove(false);
  }, [item.id]);

  const meta = SERVER_STATUS_META[item.status];
  const blocked = isServerStatusBlocked(item.status);
  const address = serverDisplayAddress(item);
  const touch = layout === 'touch';
  const busy = actionsDisabled || pending;

  const showSwitch = typeof onSwitch === 'function';
  const showNewWindow = item.canOpenInNewWindow && typeof onOpenInNewWindow === 'function';
  const showEdit = item.canEdit && typeof onEdit === 'function';
  const showRemove = item.canRemove && typeof onRemove === 'function';
  const hasMenu = showSwitch || showNewWindow || showEdit || showRemove;

  const defaultDisabled =
    busy || (guardDefaultByStatus && !item.isDefault && blocked);
  const switchDisabled = busy || item.isCurrent;

  // Touch rows read at phone size: the status and address lines step up from
  // micro to meta, and the dot sits on the name line instead of mid-row.
  const mainBody = (
    <>
      <span
        className={cn(statusDotClass(item.status, refreshing || item.status === 'checking'), touch && 'mt-1.5')}
        aria-hidden="true"
      />
      <span className={cn('flex-1 min-w-0', touch ? 'space-y-1' : 'space-y-0.5')}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0">
          <span className="typography-ui-label font-medium truncate text-foreground min-w-0">{item.label}</span>
          <ServerRouteText item={item} onSelectRoute={onSelectRoute} />
          {item.isCurrent && (
            <span className="typography-micro flex-shrink-0 text-muted-foreground bg-muted px-1 rounded leading-none pb-px border border-border/50">
              {'Current'}
            </span>
          )}
        </span>
        <span className={statusTextClass(item.status, touch)} title={meta.description}>
          {meta.label}
          {typeof item.latencyMs === 'number' && (item.status === 'connected' || item.status === 'reachable')
            ? ` · ${item.latencyMs}ms`
            : ''}
          {refreshing && item.status !== 'checking' ? ' · checking' : ''}
        </span>
        {address ? (
          <span className={cn('block truncate font-mono text-subtle-foreground', touch ? 'typography-meta' : 'typography-micro')}>{address}</span>
        ) : null}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        'group flex gap-2 overflow-hidden rounded-md px-2.5 py-2',
        touch ? 'flex-col rounded-xl bg-[var(--surface-elevated)] px-3.5 py-3' : 'items-center',
        touch && item.isCurrent && 'bg-[var(--interactive-selection)]/25',
      )}
    >
      <div className={cn('flex min-w-0 flex-1 gap-2', touch ? 'items-start' : 'items-center')}>
        {showSwitch && !item.isCurrent ? (
          // The switch button is a full-size overlay so the route picker in
          // mainBody stays a sibling (no nested buttons) and sits above it.
          <div className={cn('relative flex gap-2 flex-1 min-w-0', touch ? 'items-start' : 'items-center', switchDisabled && 'opacity-70')}>
            <button
              type="button"
              className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => onSwitch?.(item)}
              disabled={switchDisabled}
              aria-label={`${switchLabel} to ${item.label}`}
            />
            {pending ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
            <span className={cn('pointer-events-none flex gap-2 flex-1 min-w-0 [&_[data-route-picker]]:pointer-events-auto [&_[data-route-picker]]:relative', touch ? 'items-start' : 'items-center')}>
              {mainBody}
            </span>
          </div>
        ) : (
          <div className={cn('flex gap-2 flex-1 min-w-0', touch ? 'items-start' : 'items-center')} aria-label={item.isCurrent ? `Current server ${item.label}` : undefined}>
            {mainBody}
          </div>
        )}

        <div className="flex items-center gap-1 flex-shrink-0">
          {typeof onSetDefault === 'function' && (
            <button
              type="button"
              className={cn(
                'rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                // Touch layout (phones): all row targets stay at least 44px.
                touch ? 'h-11 w-11' : 'h-8 w-8',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                item.isDefault
                  ? 'text-primary hover:text-primary/80'
                  : 'text-subtle-foreground hover:text-primary/80',
                defaultDisabled && 'opacity-40 cursor-not-allowed',
              )}
              onClick={() => onSetDefault?.(item)}
              disabled={defaultDisabled}
              aria-label={item.isDefault ? `Default server ${item.label}` : `Set ${item.label} as default server`}
              aria-pressed={item.isDefault}
              title={item.isDefault ? 'Default' : 'Set as default'}
            >
              <Icon name={item.isDefault ? 'star-fill' : 'star'} className="h-4 w-4" aria-hidden="true" />
            </button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'rounded-md inline-flex items-center justify-center text-subtle-foreground hover:text-foreground hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40',
                    touch ? 'h-11 w-11' : 'h-8 w-8',
                  )}
                  aria-label={`Actions for ${item.label}`}
                  disabled={busy}
                >
                  <Icon name="more" className="h-4 w-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" portalToBody>
                {showSwitch && (
                  <DropdownMenuItem
                    disabled={switchDisabled}
                    onSelect={() => onSwitch?.(item)}
                  >
                    {item.isCurrent ? 'Current server' : `${switchLabel} to this server`}
                  </DropdownMenuItem>
                )}
                {showNewWindow && (
                  <DropdownMenuItem
                    disabled={busy || blocked}
                    onSelect={() => onOpenInNewWindow?.(item)}
                  >
                    {blocked ? 'Server unreachable' : 'Open in new window'}
                  </DropdownMenuItem>
                )}
                {showEdit && (
                  <DropdownMenuItem disabled={busy} onSelect={() => onEdit?.(item)}>
                    {'Edit'}
                  </DropdownMenuItem>
                )}
                {showRemove && (showSwitch || showNewWindow || showEdit) && <DropdownMenuSeparator />}
                {showRemove && (
                  <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setConfirmingRemove(true)}>
                    {'Remove'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {confirmingRemove && showRemove && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2"
        >
          <span className="typography-ui-label flex-1 min-w-0 text-foreground">
            {`Remove ${item.label}?`}
          </span>
          <Button
            type="button"
            variant="destructive"
            size={touch ? 'sm' : 'xs'}
            className={touch ? 'min-h-[44px]' : undefined}
            disabled={busy}
            onClick={() => {
              setConfirmingRemove(false);
              onRemove?.(item);
            }}
            aria-label={`Confirm remove ${item.label}`}
          >
            {'Remove'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size={touch ? 'sm' : 'xs'}
            className={touch ? 'min-h-[44px]' : undefined}
            onClick={() => setConfirmingRemove(false)}
            aria-label={`Keep ${item.label}`}
          >
            {'Keep'}
          </Button>
        </div>
      )}
    </div>
  );
};
