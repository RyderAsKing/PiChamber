export interface Snippet {
  name: string;
  content: string;
  aliases: string[];
  description?: string;
  filePath: string;
  source: 'global' | 'project';
  /** Whether this Pi top-level template can be changed through the daemon. */
  editable?: boolean;
}
