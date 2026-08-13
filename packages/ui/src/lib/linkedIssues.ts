export type LinkedIssue = { id: string; url?: string; title?: string; number?: number };
export const buildLinkedIssueId = () => "";
export const buildLinkedIssue = () => ({ id: "" });
export const getLinkedIssues = (): LinkedIssue[] => [];
export const withLinkedIssue = (session: unknown) => session;
