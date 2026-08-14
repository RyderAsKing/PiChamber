/* eslint-disable */
export type LinkedIssue = { id: string; url?: string; title?: string; number?: number };
export const buildLinkedIssueId = () => "";
export const buildLinkedIssue = (_input?: any) => ({ id: "", ..._input });
export const getLinkedIssues = (): LinkedIssue[] => [];
export const withLinkedIssue = (session: unknown) => session;
