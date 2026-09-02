export type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

export const createIndexSelectionStore = (initialValue = 0): IndexSelectionStore => {
  let value = initialValue;
  const listeners = new Set<() => void>();
  const indexListeners = new Map<number, Set<() => void>>();

  const notify = (index: number) => {
    const set = indexListeners.get(index);
    if (!set) return;
    for (const listener of set) listener();
  };

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeIndex: (index, listener) => {
      let set = indexListeners.get(index);
      if (!set) {
        set = new Set();
        indexListeners.set(index, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) indexListeners.delete(index);
      };
    },
    set: (nextValue) => {
      if (value === nextValue) return;
      const previousValue = value;
      value = nextValue;
      notify(previousValue);
      notify(nextValue);
      for (const listener of listeners) listener();
    },
  };
};
