/* eslint-disable */
import { create } from "zustand";
import type { Agent } from "@/lib/chat/types";
export const getConfigDirectory = () => null;
export type AgentScope = "user" | "project";
export interface AgentConfig { name?: string }
export interface AgentMutationResult { ok: boolean }
export type AgentWithExtras = Agent & { extras?: unknown };
export const isAgentBuiltIn = () => false;
export const isAgentHidden = () => false;
export const filterVisibleAgents = (agents: Agent[]) => agents;
export interface AgentDraft { name: string }
export const useAgentsStore = create(() => ({
  agents: [] as Agent[],
  loadAgents: async (..._args: unknown[]) => {},
  load: async () => {},
  createAgent: async () => ({ ok: true }),
  selectedAgent: null as string | null,
  setSelectedAgent: (_name: string | null) => {},
}));
export async function refreshAfterOpenCodeRestart() {}
export async function reloadOpenCodeConfiguration() {}
