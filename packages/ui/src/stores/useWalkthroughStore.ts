import { create } from "zustand";
export const useWalkthroughStore = create(() => ({
  active: false,
  start: () => {},
  stop: () => {},
}));
