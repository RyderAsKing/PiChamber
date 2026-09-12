import { getPiSessionStore } from '@/apps/pi-session-store';
import { isPiThinkingLevel } from '@/lib/pi/thinking';
import { sanitizeFilename } from '@/lib/pi/attachments';
import { getRuntimeKey } from '@/lib/runtime-switch';
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
  operationId?: string;
  streamEpoch?: string;
  knownEmptyTranscript?: boolean;
}): Promise<void> {
  const delivery =
    params.delivery === 'steer' || params.delivery === 'followUp'
      ? params.delivery
      : 'prompt';
  const runtimeKey = params.runtimeKey ?? getRuntimeKey();
  const assertRuntime = () => {
    if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed before sending message.');
  };
  assertRuntime();
  const sessionStore = getPiSessionStore();
  // Model/thinking commits are runtime-guarded after each await. The daemon
  // resolves the session by id, so no directory is forwarded here; if the
  // parent store gains optional directory/runtime scope for these methods,
  // forward the captured { directory, runtimeKey } instead of mutable focus.
  // Pi resets thinking to the model default during setModel. The reducer may
  // still report the old level when the model request resolves, so a model
  // change always invalidates the cached thinking value for this send.
  let modelChanged = false;
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
      assertRuntime();
      modelChanged = true;
    }
  }
  if (params.sessionId && isPiThinkingLevel(params.variant)) {
    const currentThinking = committedSessionSelection(params.sessionId).thinking;
    if (modelChanged || currentThinking !== params.variant) {
      await sessionStore.setThinking(params.sessionId, params.variant);
      assertRuntime();
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
          assertRuntime();
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
    assertRuntime();
    const promptAttachments = attachments.length > 0 ? attachments : undefined;
    await sessionStore.prompt(
      params.sessionId,
      params.content,
      delivery,
      promptAttachments,
      {
        ...(params.knownEmptyTranscript ? { knownEmptyTranscript: true } : {}),
        ...(params.operationId ? { operationId: params.operationId } : {}),
        ...(params.streamEpoch ? { streamEpoch: params.streamEpoch } : {}),
        ...(params.directory ? { directory: params.directory } : {}),
        runtimeKey,
      },
    );
  } catch (error) {
    // An unconfirmed send may have been accepted before the transport was
    // lost; the SDK may still own the refreshed uploads. Preserve them so
    // Check-status recovery can reconcile through the original receipt.
    // Matched by name (not instanceof) so partial `pi/client` mocks that
    // omit the error class cannot break this module's import graph.
    // Never delete an old runtime's uploads on a newly selected host.
    if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'PiSendUnconfirmedError') throw error;
    await Promise.all(
      (runtimeKey === getRuntimeKey() ? refreshedIds : []).map((id) =>
        sessionStore.deleteUpload(id).catch(() => undefined)
      )
    );
    throw error;
  }
}
