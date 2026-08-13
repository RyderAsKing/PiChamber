import { create } from 'zustand';

export type InlineCommentDraft = Record<string, unknown>;
export type InlineCommentDraftTarget = Record<string, unknown>;
export const EMPTY_INLINE_COMMENT_DRAFTS: Record<string, InlineCommentDraft> = {};
export const getInlineCommentDraftKey = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(':');

type InlineCommentDraftState = {
  drafts: Record<string, InlineCommentDraft>;
  addDraft: (...args: unknown[]) => void;
  clearSessionDrafts: (...args: unknown[]) => void;
};

export const useInlineCommentDraftStore = create<InlineCommentDraftState>()(() => ({
  drafts: {},
  addDraft: () => {},
  clearSessionDrafts: () => {},
}));
