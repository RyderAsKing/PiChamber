import * as React from 'react';
import { ServerRow, type ServerRowProps } from './ServerRow';
import type { ServerListItem } from '@/lib/servers/serverViewModel';

export type ServerListProps = Omit<ServerRowProps, 'item' | 'pending'> & {
  items: ServerListItem[];
  emptyMessage?: string;
  /** One host is mid-switch; that row shows progress and disables actions. */
  pendingId?: string | null;
};

export const ServerList: React.FC<ServerListProps> = ({
  items,
  emptyMessage = 'No servers yet.',
  pendingId = null,
  ...rowProps
}) => {
  if (items.length === 0) {
    return <p className="typography-meta text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <div className="space-y-1" role="list" aria-label="Servers">
      {items.map((item) => (
        <div key={item.id} role="listitem">
          <ServerRow item={item} pending={pendingId === item.id} {...rowProps} />
        </div>
      ))}
    </div>
  );
};
