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
  extensionChoice = false,
}: {
  authoritative: ComposerModelSelection;
  observed: ComposerModelSelection | null;
  composer: ComposerModelSelection;
  /** An extension command chose this selection since the composer last
   *  looked (a mode command): it is newer than any unsent composer pick. */
  extensionChoice?: boolean;
}): AuthoritativeSelectionAction => {
  const composerMatches = composer.providerId === authoritative.providerId
    && composer.modelId === authoritative.modelId
    && (authoritative.thinking === undefined || composer.thinking === authoritative.thinking);

  if (extensionChoice) {
    return composerMatches ? 'observe' : 'apply';
  }

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
    // Model and thinking picks are local until send. A later thinking echo
    // still references the previous committed model and must not restore it
    // over the newer manual composer choice.
    return 'observe';
  }

  return composerMatches ? 'observe' : 'apply';
};
