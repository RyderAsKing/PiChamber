/* eslint-disable */
import { create } from "zustand";
export const useWorktreeOrderStore = create(() => ({
  order: [] as string[],
  setOrder: (_order: string[]) => {},
}));
export const orderWorktrees = <T,>(worktrees: T[]): T[] => worktrees;
