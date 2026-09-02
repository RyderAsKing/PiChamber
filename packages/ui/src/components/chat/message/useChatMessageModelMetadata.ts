import React from 'react';
import type { Message } from '@/lib/chat/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useShallow } from 'zustand/react/shallow';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import type { TurnGroupingContext } from '../lib/turns/types';
import {
  getMessageInfoProp,
  getMessageModelRef,
  readNonEmptyString,
  useStickyDisplayValue,
} from './chatMessageMetadata';

export function useChatMessageModelMetadata({
  message,
  previousMessage,
  isUser,
  sessionId,
  isInActiveTurn,
  turnGroupingContext,
}: {
  message: { info: Message };
  previousMessage?: { info: Message };
  isUser: boolean;
  sessionId: string | undefined;
  isInActiveTurn: boolean;
  turnGroupingContext?: TurnGroupingContext;
}) {
  const providers = useConfigStore((state) => state.providers);
  const getAgentModelForSession = useSelectionStore((s) => s.getAgentModelForSession);
  const getSessionModelSelection = useSelectionStore((s) => s.getSessionModelSelection);

  const { currentContextAgent, savedSessionAgentSelection } = useContextStore(
    useShallow((state) => ({
      currentContextAgent: isInActiveTurn && sessionId ? state.currentAgentContext.get(sessionId) : undefined,
      savedSessionAgentSelection: isInActiveTurn && sessionId ? state.sessionAgentSelections.get(sessionId) : undefined,
    })),
  );

  const previousUserMetadata = React.useMemo(() => {
    if (isUser || !previousMessage) {
      return null;
    }

    const clientRole = getMessageInfoProp(previousMessage.info, 'clientRole');
    const role = getMessageInfoProp(previousMessage.info, 'role');
    const previousRole = typeof clientRole === 'string' ? clientRole : typeof role === 'string' ? role : undefined;
    if (previousRole !== 'user') {
      return null;
    }

    const mode = getMessageInfoProp(previousMessage.info, 'mode');
    const agent = getMessageInfoProp(previousMessage.info, 'agent');
    const previousModel = getMessageModelRef(previousMessage.info);
    const variant = getMessageInfoProp(previousMessage.info, 'variant');
    const resolvedAgent =
      typeof mode === 'string' && mode.trim().length > 0
        ? mode
        : typeof agent === 'string' && agent.trim().length > 0
          ? agent
          : undefined;
    const resolvedProvider = previousModel.providerId;
    const resolvedModel = previousModel.modelId;
    const resolvedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant : undefined;

    if (!resolvedAgent && !resolvedProvider && !resolvedModel && !resolvedVariant) {
      return null;
    }

    return {
      agentName: resolvedAgent,
      providerId: resolvedProvider,
      modelId: resolvedModel,
      variant: resolvedVariant,
    };
  }, [isUser, previousMessage]);

  const agentName = React.useMemo(() => {
    if (isUser) return undefined;

    const messageMode = getMessageInfoProp(message.info, 'mode');
    if (typeof messageMode === 'string' && messageMode.trim().length > 0) {
      return messageMode;
    }

    const messageAgent = getMessageInfoProp(message.info, 'agent');
    if (typeof messageAgent === 'string' && messageAgent.trim().length > 0) {
      return messageAgent;
    }

    if (previousUserMetadata?.agentName) {
      return previousUserMetadata.agentName;
    }

    if (!sessionId) {
      return undefined;
    }

    if (currentContextAgent) {
      return currentContextAgent;
    }

    return savedSessionAgentSelection ?? undefined;
  }, [isUser, message.info, previousUserMetadata, sessionId, currentContextAgent, savedSessionAgentSelection]);

  const messageModel = !isUser ? getMessageModelRef(message.info) : { providerId: undefined, modelId: undefined };
  const messageProviderID = messageModel.providerId ?? null;
  const messageModelID = messageModel.modelId ?? null;

  const contextModelSelection = React.useMemo(() => {
    if (isUser || !sessionId) return null;

    if (previousUserMetadata?.providerId && previousUserMetadata?.modelId) {
      return {
        providerId: previousUserMetadata.providerId,
        modelId: previousUserMetadata.modelId,
      };
    }

    if (agentName) {
      const agentSelection = getAgentModelForSession(sessionId, agentName);
      if (agentSelection?.providerId && agentSelection?.modelId) {
        return agentSelection;
      }
    }

    const sessionSelection = getSessionModelSelection(sessionId);
    if (sessionSelection?.providerId && sessionSelection?.modelId) {
      return sessionSelection;
    }

    return null;
  }, [isUser, sessionId, agentName, previousUserMetadata, getAgentModelForSession, getSessionModelSelection]);

  const providerID = React.useMemo(() => {
    if (isUser) return null;
    if (typeof messageProviderID === 'string' && messageProviderID.trim().length > 0) {
      return messageProviderID;
    }
    return contextModelSelection?.providerId ?? null;
  }, [isUser, messageProviderID, contextModelSelection]);

  const modelID = React.useMemo(() => {
    if (isUser) return null;
    if (typeof messageModelID === 'string' && messageModelID.trim().length > 0) {
      return messageModelID;
    }
    return contextModelSelection?.modelId ?? null;
  }, [isUser, messageModelID, contextModelSelection]);

  const modelName = React.useMemo(() => {
    if (isUser) return undefined;

    const provider = providerID && providers.length > 0 ? providers.find((p) => p.id === providerID) : undefined;
    return getProviderModelDisplayName(provider, modelID) || undefined;
  }, [isUser, providerID, modelID, providers]);

  const modelHasVariants = React.useMemo(() => {
    if (isUser) return false;
    if (!providerID || !modelID) return false;

    const provider = providers.find((p) => p.id === providerID);
    if (!provider?.models || !Array.isArray(provider.models)) {
      return false;
    }

    const model = provider.models.find(
      (m: Record<string, unknown>) => (m as Record<string, unknown>).id === modelID,
    ) as { variants?: Record<string, unknown> } | undefined;

    const variants = model?.variants;
    return Boolean(variants && Object.keys(variants).length > 0);
  }, [isUser, modelID, providerID, providers]);

  const displayAgentName = useStickyDisplayValue<string>(agentName);
  const displayProviderIDValue = useStickyDisplayValue<string>(providerID ?? undefined);
  const displayModelName = useStickyDisplayValue<string>(modelName);

  const headerAgentName = displayAgentName ?? undefined;
  const headerProviderID = displayProviderIDValue ?? null;
  const headerModelName = displayModelName ?? undefined;

  const headerVariantRaw = !isUser
    ? (readNonEmptyString(getMessageInfoProp(message.info, 'variant')) ??
      turnGroupingContext?.userMessageVariant ??
      previousUserMetadata?.variant)
    : undefined;

  const headerVariant = !isUser
    ? modelHasVariants
      ? (headerVariantRaw ?? 'Default')
      : headerVariantRaw
    : undefined;

  return {
    headerAgentName,
    headerProviderID,
    headerModelName,
    headerVariant,
  };
}
