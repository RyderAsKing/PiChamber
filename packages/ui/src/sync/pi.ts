/**
 * Sync-layer Pi owner exports.
 *
 * The sync-context layer consumes these wrappers rather than the pure
 * helpers under `packages/ui/src/lib/pi/`. Keeping the two surfaces
 * separate means the pure helpers stay easy to unit-test while the
 * zustand-aware wrappers can evolve with the sync layer.
 */

export {
  bootstrapPiDirectoryForStore,
  type PiSyncBootstrapController,
  type PiSyncBootstrapInput,
  type PiSyncBootstrapStore,
} from './pi-bootstrap';

export {
  reconnectPiSessionForStore,
  type PiSyncReconnectController,
  type PiSyncReconnectInput,
} from './pi-reconnect';

export {
  applySnapshotReducer,
  createSnapshotState,
  getLastSequence,
  getSnapshotView,
  projectSnapshot,
  resetSnapshot,
  upsertSnapshot,
} from './pi-snapshot';

export {
  createPiReducerState,
  projectReducerSession,
  projectReducerSessions,
  reduceEvent,
  reduceEvents,
} from './pi-event-reducer';
