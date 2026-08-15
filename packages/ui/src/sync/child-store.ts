/* eslint-disable */
export type DirectoryBootstrapPriority = "selected" | "active-project" | "expanded" | "visible" | "background";
export type DirectoryBootstrapReason = string;
export type DirectoryBootstrapDemand = { directory: string; priority: DirectoryBootstrapPriority; reason: DirectoryBootstrapReason };
export class ChildStoreManager {
  getState() { return undefined; }
  get(directory?: string) { return undefined; }
}
