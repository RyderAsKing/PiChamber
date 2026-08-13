import { create } from "zustand";
export const selectPendingOpenCodeRestartCount = () => 0;
export const usePendingOpenCodeRestartStore = create(() => ({ count: 0 }));
