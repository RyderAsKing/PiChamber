import { getModelDisplayName, getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';

interface RunModel {
  providerId: string | null;
  modelId: string;
}

/** A run's `provider/model` string, split. A bare id has no provider. */
export const splitRunModel = (model: string | undefined): RunModel | null => {
  const value = model?.trim();
  if (!value) return null;
  const slash = value.indexOf('/');
  if (slash <= 0) return { providerId: null, modelId: value };
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
};

/** The model's display name, from the configured providers when known. */
export const useRunModelName = (model: RunModel | null): string => {
  const provider = useConfigStore((state) => (
    model?.providerId ? state.providers.find((entry) => entry.id === model.providerId) : undefined
  ));
  if (!model) return '';
  return provider
    ? getProviderModelDisplayName(provider, model.modelId)
    : getModelDisplayName(null, model.modelId);
};
