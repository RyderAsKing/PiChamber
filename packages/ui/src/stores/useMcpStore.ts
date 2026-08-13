import { create } from "zustand";

export type McpStatusMap = Record<string, unknown>;
export const computeMcpHealth = () => ({ ok: true });

const EMPTY_MCP_STATUS: McpStatusMap = {};

/**
 * MCP servers are a deferred follow-up feature in the Pi port. This store keeps
 * the work-status/header MCP wiring intact while behaving as a stable no-op:
 * no servers are configured, so directory status is a stable empty map and
 * refresh/connect/disconnect are no-ops.
 */
export const useMcpStore = create(() => ({
  status: {} as McpStatusMap,
  load: async () => {},
  getStatusForDirectory: () => EMPTY_MCP_STATUS,
  refresh: async () => {},
  connect: async () => {},
  disconnect: async () => {},
}));
