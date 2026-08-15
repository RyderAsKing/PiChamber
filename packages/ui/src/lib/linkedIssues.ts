export type LinkedIssue = {
  id: string;
  url?: string;
  title?: string;
  number?: number;
  kind?: 'issue' | 'pull';
  author?: unknown;
  authorAvatarUrl?: string;
  [key: string]: unknown;
};

export const buildLinkedIssue = (input?: Partial<LinkedIssue>): LinkedIssue => ({
  id: '',
  ...input,
});

export const getLinkedIssues = (_session?: unknown): LinkedIssue[] => {
  void _session;
  return [];
};
