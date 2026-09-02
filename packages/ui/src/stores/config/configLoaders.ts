import { piClient } from '@/lib/pi/client';
import { configuredProviders } from '@/lib/pi/configured-providers';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { ProviderModel, ProviderWithModelList } from './selection';

export interface ProcessedProvidersResult {
  providers: ProviderWithModelList[];
  defaults: Record<string, string>;
}

export const fetchAndProcessProviders = async (): Promise<ProcessedProvidersResult> => {
  const response = await piClient.listProviders({
    runtimeKey: getRuntimeKey(),
  });
  const configured = configuredProviders(response.providers);
  const providers: ProviderWithModelList[] = configured.map((provider) => {
    const models: ProviderModel[] = provider.models.map((model) => ({
      id: model.id,
      name: model.label ?? model.id,
      providerID: model.providerId,
      reasoning: model.supportsThinking === true,
      ...(Number.isSafeInteger(model.contextWindow)
        ? { limit: { context: model.contextWindow } }
        : {}),
      ...(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0
        ? { thinkingLevels: model.thinkingLevels }
        : {}),
    }));

    return {
      id: provider.id,
      name: provider.label ?? provider.id,
      authenticated: provider.authenticated === true,
      models,
    };
  });

  const defaults: Record<string, string> = response.default
    ? { [response.default.providerId]: response.default.modelId }
    : {};

  return { providers, defaults };
};
