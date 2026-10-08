import React from 'react';
import i18n from '@/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import type { GitHubContextType } from '@/lib/api/types';
import { buildAgentContextPayloadText, buildAgentContextVisibleText, type AgentContextKind } from './pullLogic';

/**
 * Single well-named callback hook for every "Send to agent" entry point.
 *
 * Fetches the server `context` route (`RuntimeAPIs.github.agentContext`) and
 * inserts it into the active session composer:
 * - visible text via `useInputStore.setPendingInputText(..., 'append')` so the
 *   user reviews before sending (never auto-send);
 * - full quoted payload via `setPendingSyntheticParts` (ConflictDialog
 *   precedent), which the submit path sends alongside the visible text.
 *
 * Composer gap: there is no additive chip/attachment API for GitHub context
 * (`application/vnd.github.pull-request-link` renders only message links, it
 * does not accept ad-hoc context payloads). Inserting a synthetic part keeps
 * the payload attached to the next send without composer changes. A future
 * first-class context chip would need a composer attachment kind plus
 * `submit/buildOutgoingMessage` support; this hook's `{ visibleText,
 * payloadText }` return shape is the seam for that upgrade.
 */
export const useSendGitHubContextToComposer = () => {
  const apis = useRuntimeAPIs();
  const [sendingKey, setSendingKey] = React.useState<string | null>(null);

  const send = React.useCallback(
    async (input: {
      key: string;
      kind: AgentContextKind;
      directory: string;
      repo: string;
      number: number;
      contextType: GitHubContextType;
      contextOptions?: { ref?: string; includeDiff?: boolean };
      detail?: string;
    }): Promise<boolean> => {
      const github = apis.github;
      if (!github) {
        toast.error(i18n.t('GitHub is not available in this runtime'));
        return false;
      }
      setSendingKey(input.key);
      try {
        const result = await github.agentContext(input.directory, input.repo, input.contextType, input.number, input.contextOptions);
        const visibleText = buildAgentContextVisibleText({
          kind: input.kind,
          repo: input.repo,
          number: input.number,
          detail: input.detail,
        });
        const payloadText = buildAgentContextPayloadText({
          kind: input.kind,
          repo: input.repo,
          number: input.number,
          contextText: result.text,
        });
        const store = useInputStore.getState();
        store.setPendingInputText(visibleText, 'append');
        const existing = store.pendingSyntheticParts ?? [];
        store.setPendingSyntheticParts([...existing, { text: payloadText, synthetic: true }]);
        toast.success(i18n.t('Added to composer'));
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : i18n.t('Failed to fetch GitHub context'));
        return false;
      } finally {
        setSendingKey(null);
      }
    },
    [apis.github],
  );

  return { send, sendingKey };
};
