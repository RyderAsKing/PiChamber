import React from 'react';
import { toast } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import type { ProjectIdentitySaveData } from './useProjectIdentityForm';
import type { useProjectIdentityForm } from './useProjectIdentityForm';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

const AUTO_SAVE_DELAY_MS = 450;

export const useProjectIdentityAutoSave = (
  form: ProjectIdentityFormState,
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>,
) => {
  const { t } = useTranslation();
  const {
    hasChanges,
    name,
    defaultModel,
    prepareSaveData,
  } = form;

  const isSavingRef = React.useRef(false);

  React.useEffect(() => {
    if (!hasChanges || !name.trim() || isSavingRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingRef.current) {
        return;
      }
      isSavingRef.current = true;
      void (async () => {
        try {
          const data = await prepareSaveData();
          if (data) {
            try {
              await onSave(data);
            } catch {
              toast.error(t('Failed to save project settings'));
            }
          }
        } finally {
          isSavingRef.current = false;
        }
      })();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    defaultModel,
    hasChanges,
    name,
    onSave,
    prepareSaveData,
    t,
  ]);
};
