/* eslint-disable */
export type DirectoryStore = Record<string, unknown>;
export function subscribeDirectorySessionMessages() { return () => {}; }
export function markDirectorySessionPartChanged() {}
export function subscribeDirectoryPermission() { return () => {}; }
export function subscribeDirectoryQuestion() { return () => {}; }
export function subscribeDirectoryQuestions() { return () => {}; }
export type DirectoryBootstrapPriority = "selected" | "active-project" | "expanded" | "visible" | "background";
export type DirectoryBootstrapReason = string;
export type DirectoryBootstrapDemand = Record<string, unknown>;
export type DirectoryBootstrapState = "queued" | "running" | "complete" | "failed";
export type DirectoryBootstrapFailureReason = "os-permission" | "generic";
export type DirectoryBootstrapContext = DirectoryBootstrapDemand;
export class ChildStoreManager {
  getState() { return undefined; }
  get(directory?: string) { return undefined; }
}
