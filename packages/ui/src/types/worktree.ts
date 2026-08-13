export type WorktreeMetadata = {
  path?: string | null;
  branch?: string | null;
  head?: string | null;
  projectRoot?: string | null;
  [key: string]: unknown;
};
