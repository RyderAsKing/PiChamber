import React from 'react';
import type { SessionShelfSection } from '@/lib/sessionShelf';

/**
 * Shelf state for rows in the Threads and By folder views. `null` in the
 * other views, where rows show no snooze controls.
 */
export interface SessionShelfRowState {
  sectionById: ReadonlyMap<string, SessionShelfSection>;
  wokeIds: ReadonlySet<string>;
}

export const SessionShelfRowContext = React.createContext<SessionShelfRowState | null>(null);
