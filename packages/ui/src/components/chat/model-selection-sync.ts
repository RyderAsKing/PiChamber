import type { PiThinkingLevel } from '@/lib/pi/types';

type ComposerModelSelection = {
  providerId?: string;
  modelId?: string;
  thinking?: PiThinkingLevel;
};

type AuthoritativeSelectionAction = 'ignore' | 'observe' | 'apply';

export const classifyAuthoritativeComposerSelection = ({
  authoritative,
  observed,
  composer,
}: {
  authoritative: ComposerModelSelection;
  observed: ComposerModelSelection | null;
  composer: ComposerModelSelection;
}): AuthoritativeSelectionAction => {
  if (
    observed
    && observed.providerId === authoritative.providerId
    && observed.modelId === authoritative.modelId
    && (observed.thinking ?? undefined) === (authoritative.thinking ?? undefined)
  ) {
    return 'ignore';
  }

  const authoritativeModelWasAlreadyObserved = observed?.providerId === authoritative.providerId
    && observed?.modelId === authoritative.modelId;
  const composerUsesDifferentModel = composer.providerId !== authoritative.providerId
    || composer.modelId !== authoritative.modelId;
  if (authoritativeModelWasAlreadyObserved && composerUsesDifferentModel) {
    // Model picks are local until send, while thinking changes are applied live.
    // A thinking echo therefore still references the previous authoritative
    // model and must not restore it over the newer manual composer choice.
    return 'observe';
  }

  const composerMatches = composer.providerId === authoritative.providerId
    && composer.modelId === authoritative.modelId
    && (authoritative.thinking === undefined || composer.thinking === authoritative.thinking);

  return composerMatches ? 'observe' : 'apply';
};
