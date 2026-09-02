import React from 'react';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveDraftWelcomeProjectLabel } from './composer/state/draftTargetProjects';

const renderDraftTitle = (
  title: string,
  projectLabel: string | null
): React.ReactNode => {
  if (!projectLabel) return title;
  const projectIndex = title.indexOf(projectLabel);
  if (projectIndex === -1) return title;

  return (
    <>
      {title.slice(0, projectIndex)}
      <span className="font-medium">{projectLabel}</span>
      {title.slice(projectIndex + projectLabel.length)}
    </>
  );
};

export const DraftWelcome: React.FC = () => {
  const selectedProjectId = useSessionUIStore(
    (state) => state.newSessionDraft.selectedProjectId ?? null
  );
  const projectLabel = useProjectsStore(
    React.useCallback(
      (state) =>
        resolveDraftWelcomeProjectLabel({
          selectedProjectId,
          activeProjectId: state.activeProjectId,
          projects: state.projects,
        }),
      [selectedProjectId]
    )
  );

  return (
    <div className="oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
        {renderDraftTitle(
          projectLabel
            ? `What are we working on in ${projectLabel}?`
            : "What are we working on?",
          projectLabel
        )}
      </h1>
      <DraftPresetChips
        onSubmit={(starter) =>
          useInputStore
            .getState()
            .requestPresetSubmit(starter.submitText, starter.ref.type)
        }
        className="oc-draft-starters mt-8 max-w-md"
      />
    </div>
  );
};
