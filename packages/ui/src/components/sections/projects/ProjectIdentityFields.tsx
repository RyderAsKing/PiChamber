import React from 'react';
import { Input } from '@/components/ui/input';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { SettingsModelPicker } from '@/components/sections/shared/SettingsModelPicker';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import { useConfigStore } from '@/stores/useConfigStore';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type ProjectIdentityFieldsProps = {
  form: ProjectIdentityFormState;
};

const FULL_WIDTH_CONTROL = 'w-full max-w-none';

export const ProjectIdentityFields: React.FC<ProjectIdentityFieldsProps> = ({ form }) => {
  const {
    name,
    setName,
    parsedDefaultModel,
    handleDefaultModelChange,
    project,
  } = form;
  const loadProviders = useConfigStore((state) => state.loadProviders);

  React.useEffect(() => {
    void loadProviders({ source: 'projectSettings' });
  }, [loadProviders]);

  if (!project) {
    return null;
  }

  return (
    <ProjectSettingsSubsection
      title={"Project"}
      divider={false}
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsStackedField
          label={"Name"}
          settingsItem="projects.name"
          controlClassName={FULL_WIDTH_CONTROL}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={"Project name"}
            aria-label={"Project name"}
            className="h-8 w-full rounded-md px-3"
          />
        </SettingsStackedField>

        <SettingsStackedField
          label={"Default model"}
          info={"Used when starting a new chat in this project. Unset keeps the global session default."}
          settingsItem="projects.default-model"
          controlClassName={FULL_WIDTH_CONTROL}
        >
          <SettingsModelPicker
            value={parsedDefaultModel}
            noneLabel={"Use global default"}
            ariaLabel={"Default model for new chats"}
            className={FULL_WIDTH_CONTROL}
            onChange={(model) => {
              if (!model) {
                handleDefaultModelChange('', '');
                return;
              }
              handleDefaultModelChange(model.providerId, model.modelId);
            }}
          />
        </SettingsStackedField>
      </div>
    </ProjectSettingsSubsection>
  );
};
