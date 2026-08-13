/* eslint-disable */
import { create } from "zustand";
export type McpDraft = Record<string, unknown>;
export const useMcpConfigStore = create(() => ({
  mcpServers: [] as Array<{ name: string }>,
  loadMcpConfigs: async () => {},
  setMcpDraft: (_draft: McpDraft) => {},
  setSelectedMcp: (_name: string | null) => {},
  selectedMcp: null as string | null,
  mcpDraft: null as McpDraft | null,
}));
