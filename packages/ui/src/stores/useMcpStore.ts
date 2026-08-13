import { create } from "zustand";
export type McpStatusMap = Record<string, unknown>;
export const computeMcpHealth = () => ({ ok: true });
export const useMcpStore = create(() => ({
  status: {} as McpStatusMap,
  load: async () => {},
}));
