import { getPiSessionStore } from '@/apps/pi-session-store';
import { isPiThinkingLevel } from '@/lib/pi/thinking';
import { sanitizeFilename } from '@/lib/pi/attachments';
import type { AttachedFile } from './session-ui-types';

export function committedSessionSelection(sessionId: string) {
  const state = getPiSessionStore().getState();
  const live = state.reducer.bySession.get(sessionId);
  const listed = state.sessions.find(
    (item) => item.session.id === sessionId
  )?.session;
  return {
    model: live?.model ?? listed?.model,
    thinking: live?.thinking ?? listed?.thinking,
  };
}

export async function routeMessage(params: {
  runtimeKey?: string;
  sessionId: string;
  directory?: string | null;
  content: string;
  providerID: string;
  modelID: string;
  agent?: string;
  agentMentionName?: string;
  variant?: string;
  inputMode?: 'normal' | 'shell';
  files?: Array<{
    type: 'file';
    mime: string;
    url: string;
    filename: string;
    uploadState?: AttachedFile['uploadState'];
  }>;
  additionalParts?: Array<{
    text: string;
    synthetic?: boolean;
    files?: Array<{
      type: 'file';
      mime: string;
      url: string;
      filename: string;
      uploadState?: AttachedFile['uploadState'];
    }>;
  }>;
  delivery?: 'steer' | 'followUp' | 'prompt';
  knownEmptyTranscript?: boolean;
}): Promise<void> {
  const delivery =
    params.delivery === 'steer' || params.delivery === 'followUp'
      ? params.delivery
      : 'prompt';
  const sessionStore = getPiSessionStore();
  if (params.sessionId && params.providerID && params.modelID) {
    const currentModel = committedSessionSelection(params.sessionId).model;
    if (
      !currentModel ||
      currentModel.providerId !== params.providerID ||
      currentModel.modelId !== params.modelID
    ) {
      await sessionStore.setModel(
        params.sessionId,
        params.providerID,
        params.modelID
      );
    }
  }
  if (params.sessionId && isPiThinkingLevel(params.variant)) {
    const currentThinking = committedSessionSelection(params.sessionId).thinking;
    if (currentThinking !== params.variant) {
      await sessionStore.setThinking(params.sessionId, params.variant);
    }
  }
  const outgoingFiles = [
    ...(params.files ?? []),
    ...(params.additionalParts ?? []).flatMap((part) => part.files ?? []),
  ].filter(
    (file) => file.uploadState !== undefined || file.url.startsWith('data:')
  );
  const refreshedIds: string[] = [];
  try {
    const attachments = await Promise.all(
      outgoingFiles.map(async (file) => {
        const state = file.uploadState;
        if (state?.status === 'preparing' || state?.status === 'uploading') {
          throw new Error('Attachments are still uploading.');
        }
        if (state?.status === 'failed') {
          throw new Error('Retry or remove failed attachments.');
        }
        if (state?.status === 'ready' && state.expiresAt > Date.now()) {
          return { id: state.attachmentId };
        }
        if (typeof file.url === 'string' && file.url.startsWith('data:')) {
          const response = await fetch(file.url);
          const blob = await response.blob();
          const attachment = await sessionStore.uploadFile(blob, {
            filename: sanitizeFilename(file.filename),
            mime: file.mime,
          });
          refreshedIds.push(attachment.id);
          return { id: attachment.id };
        }
        throw new Error(
          'Attachment data is unavailable. Remove the attachment and add it again.'
        );
      })
    );
    const promptAttachments = attachments.length > 0 ? attachments : undefined;
    if (params.knownEmptyTranscript) {
      await sessionStore.prompt(
        params.sessionId,
        params.content,
        delivery,
        promptAttachments,
        { knownEmptyTranscript: true },
      );
    } else {
      await sessionStore.prompt(
        params.sessionId,
        params.content,
        delivery,
        promptAttachments,
      );
    }
  } catch (error) {
    await Promise.all(
      refreshedIds.map((id) =>
        sessionStore.deleteUpload(id).catch(() => undefined)
      )
    );
    throw error;
  }
}
