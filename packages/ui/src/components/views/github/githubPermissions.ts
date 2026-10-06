import i18n from '@/i18n';
import type { GitHubCapabilities } from '@/lib/api/types';

/**
 * Shared viewer-permission gating for the PR and Issues surfaces.
 * Both entities gate the same way: state transitions that are impossible
 * stay disabled with a reason, push-gated actions allow the author on their
 * own item, and comments need read access. Without a permission shape (or on
 * resolution fallback) everything is attempted and server errors surface in
 * place.
 */

export type ActionGate = { allowed: boolean; reason: string | null };

/**
 * Viewer access for permission gating: server `capabilities` plus whether
 * the viewer authored the PR/issue. Omitted (undefined) when the server
 * sent no permission shape — gating degrades to attempting the action and
 * surfacing server errors in place.
 */
export type ViewerAccess = {
  capabilities?: GitHubCapabilities | null;
  /** True when the viewer authored this PR/issue (case-insensitive login match). */
  isAuthor?: boolean;
  /** True when permission resolution failed: everything stays enabled. */
  permissionFallback?: boolean;
} | null | undefined;

/** True when the viewer authored the item (case-insensitive login match). */
export const isAuthorLogin = (authorLogin?: string | null, viewerLogin?: string | null): boolean => {
  if (!authorLogin || !viewerLogin) return false;
  return authorLogin.toLowerCase() === viewerLogin.toLowerCase();
};

/** Push-gated action (merge, labels, resolve): the author exception does not apply. */
export const requiresPush = (access: ViewerAccess): boolean => {
  if (!access || access.permissionFallback) return false;
  return access.capabilities?.canPush !== true;
};

/** Author-or-push action (close/reopen/edit): authors act on their own items. */
export const requiresPushOrAuthor = (access: ViewerAccess): boolean => {
  if (!access || access.permissionFallback) return false;
  if (access.isAuthor) return false;
  return access.capabilities?.canPush !== true;
};

/** Comments and reviews require read access. */
export const gateCommentAccess = (access: ViewerAccess): ActionGate => {
  if (!access || access.permissionFallback) return { allowed: true, reason: null };
  if (access.capabilities?.canComment !== true) return { allowed: false, reason: i18n.t('You need read access to comment') };
  return { allowed: true, reason: null };
};

/** Shared title validation for the create-PR / create-issue forms. */
export const titleValidationError = (title: string, maxLength: number): string | null => {
  if (!title.trim()) return i18n.t('Enter a title');
  if (title.trim().length > maxLength) return i18n.t('Title is too long (max {{max}} characters)', { max: maxLength });
  return null;
};
