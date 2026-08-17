import React from 'react';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import type { ProjectEntry } from '@/lib/api/types';

export type ProjectIdentitySaveData = {
  label: string;
  defaultModel: string | null;
};

type EditableProject = Pick<
  ProjectEntry,
  'id' | 'label' | 'defaultModel' | 'path'
>;

export const useProjectIdentityForm = (project: EditableProject | null) => {
  const [name, setName] = React.useState('');
  const [defaultModel, setDefaultModel] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    if (!project) {
      setName('');
      setDefaultModel(undefined);
      return;
    }
    setName(project.label ?? '');
    setDefaultModel(project.defaultModel);
  }, [project]);

  const parsedDefaultModel = React.useMemo(
    () => parseModelIdentifier(defaultModel),
    [defaultModel],
  );

  const hasChanges = Boolean(project) && (
    name.trim() !== (project?.label ?? '').trim()
    || (defaultModel ?? undefined) !== (project?.defaultModel ?? undefined)
  );

  const handleDefaultModelChange = React.useCallback((providerId: string, modelId: string) => {
    setDefaultModel(providerId && modelId ? `${providerId}/${modelId}` : undefined);
  }, []);

  const prepareSaveData = React.useCallback(async (): Promise<ProjectIdentitySaveData | null> => {
    if (!project) {
      return null;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }

    return {
      label: trimmed,
      defaultModel: defaultModel ?? null,
    };
  }, [defaultModel, name, project]);

  return {
    name,
    setName,
    defaultModel,
    parsedDefaultModel,
    handleDefaultModelChange,
    hasChanges,
    prepareSaveData,
    project,
  };
};
