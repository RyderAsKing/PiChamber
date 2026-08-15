import { create } from 'zustand';

export type InlineCommentDraft = {
  id?: string;
  code?: string;
  fileLabel?: string;
  startLine?: number;
  endLine?: number;
  [key: string]: unknown;
};
export type InlineCommentDraftTarget = Record<string, unknown>;
export type InlineCommentSource = string;
export const EMPTY_INLINE_COMMENT_DRAFTS: readonly InlineCommentDraft[] = [];
export const getInlineCommentDraftKey = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(':');

/**
 * Inline (Pierre diff) review comments are a deferred follow-up feature in the
 * Pi port. This store keeps the composer/controller wiring intact while
 * behaving as a stable no-op: no drafts are persisted, so consume/get return
 * empty arrays and every mutation is a no-op.
 */
type InlineCommentDraftState = {
  drafts: Record<string, InlineCommentDraft[]>;
  addDraft: (target: InlineCommentDraftTarget, draft: InlineCommentDraft) => void;
  updateDraft: (target: InlineCommentDraftTarget, id: string, patch: Partial<InlineCommentDraft>) => void;
  removeDraft: (target: InlineCommentDraftTarget, id: string) => void;
  getDrafts: (target: InlineCommentDraftTarget) => InlineCommentDraft[];
  consumeDrafts: (target: InlineCommentDraftTarget) => InlineCommentDraft[];
  restoreDrafts: (target: InlineCommentDraftTarget, drafts: InlineCommentDraft[]) => void;
  clearSessionDrafts: (runtimeKey: string, directory: string, sessionId: string) => void;
};

export const useInlineCommentDraftStore = create<InlineCommentDraftState>()(() => ({
  drafts: {},
  addDraft: () => {},
  updateDraft: () => {},
  removeDraft: () => {},
  getDrafts: () => [],
  consumeDrafts: () => [],
  restoreDrafts: () => {},
  clearSessionDrafts: () => {},
}));
