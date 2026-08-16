/**
 * Cached snapshot selection, matching `useSyncExternalStoreWithSelector`.
 * If the store snapshot identity is unchanged, return the previous selection
 * without re-running the selector. Re-running an allocating selector on the
 * same snapshot makes `useSyncExternalStore` loop and freeze the tab.
 */
export const createSnapshotSelectorCache = <TSnapshot, TSelection>() => {
  let hasValue = false;
  let snapshot: TSnapshot | undefined;
  let selection: TSelection | undefined;

  return (
    nextSnapshot: TSnapshot,
    selector: (snapshot: TSnapshot) => TSelection,
    isEqual: (a: TSelection, b: TSelection) => boolean = Object.is,
  ): TSelection => {
    if (hasValue && Object.is(snapshot, nextSnapshot)) {
      return selection as TSelection;
    }
    const nextSelection = selector(nextSnapshot);
    const equal = typeof isEqual === 'function' ? isEqual : Object.is;
    if (hasValue && equal(selection as TSelection, nextSelection)) {
      snapshot = nextSnapshot;
      return selection as TSelection;
    }
    hasValue = true;
    snapshot = nextSnapshot;
    selection = nextSelection;
    return nextSelection;
  };
};

export const stringArrayEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};
