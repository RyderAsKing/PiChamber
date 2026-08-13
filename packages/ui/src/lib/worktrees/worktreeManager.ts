/* eslint-disable */
import type { WorktreeMetadata } from "@/types/worktree";
export type ProjectRef = { id: string; path: string };
export type CreateWorktreeArgs = Record<string, unknown>;
export const getLatestWorktreeMetadata = (metadata: WorktreeMetadata) => metadata;
export const worktreeMapsEqual = () => true;
export const partitionWorktreesByRegisteredProject = () => new Map<string, WorktreeMetadata[]>();
export async function listProjectWorktrees(): Promise<WorktreeMetadata[]> { return []; }
export async function createWorktree(): Promise<WorktreeMetadata> { throw new Error("Worktrees are not available"); }
export async function validateWorktreeCreate() { return { ok: false, errors: ["unavailable"] }; }
export async function removeProjectWorktree() {}
