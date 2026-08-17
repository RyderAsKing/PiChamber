/* eslint-disable */
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { configuredProviders } from '@/lib/pi/configured-providers';
import type { Agent, OpencodeClient, Provider, Session } from '@/lib/chat/types';

const directory = () => getPiSessionStore().getState().directory ?? useDirectoryStore.getState().currentDirectory ?? undefined;

export const opencodeClient = {
  getDirectory: () => directory() ?? null,
  setDirectory: (next?: string) => {
    if (!next) return;
    // `focusProject` swaps the cluster's directory pointer without disposing
    // the live event stream or dropping resident sessions, so a sidebar
    // project switch keeps background busy chats streaming.
    void getPiSessionStore().focusProject(next, null);
  },
  checkHealth: async () => {
    const health = await piClient.health({ runtimeKey: getRuntimeKey() });
    return health.state === 'ready';
  },
  clearConfigCache: () => {},
  getProvidersForConfig: async () => {
    const response = await piClient.listProviders({ runtimeKey: getRuntimeKey() });
    const providers = configuredProviders(response.providers)
      .map((provider) => ({
        id: provider.id,
        name: provider.label ?? provider.id,
        authenticated: provider.authenticated === true,
        models: Object.fromEntries(provider.models.map((model) => [model.id, {
          id: model.id,
          name: model.label ?? model.id,
          providerID: model.providerId,
          reasoning: model.supportsThinking === true,
          ...(Number.isSafeInteger(model.contextWindow) ? { limit: { context: model.contextWindow } } : {}),
          ...(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0 ? { thinkingLevels: model.thinkingLevels } : {}),
        }])),
      })) satisfies Provider[];
    return {
      providers,
      default: response.default
        ? { [response.default.providerId]: response.default.modelId }
        : {},
    };
  },
  listAgents: async (..._args: unknown[]): Promise<Agent[]> => [],
  getSessionStatusForDirectory: async () => null,
  updateSession: async (id: string, patch: { time?: { archived?: number } }) => {
    if (patch.time?.archived) await getPiSessionStore().archive(id, true);
  },
  deleteSession: async (id: string) => {
    await getPiSessionStore().remove(id);
  },
  sendMessage: async () => undefined,
  sendCommand: async () => undefined,
  shellSession: async () => undefined,
  getSdkClient: (): OpencodeClient => ({
    experimental: {
      session: {
        list: async () => {
          const result = await piClient.listSessions({ runtimeKey: getRuntimeKey(), directory: directory() ?? undefined });
          const data: Session[] = result.sessions.map((item) => ({
            id: item.session.id,
            directory: item.session.directory,
            title: item.session.title,
            time: {
              created: item.session.createdAt,
              updated: item.session.updatedAt,
              ...(item.session.archived ? { archived: item.session.timeArchived } : {}),
            },
          }));
          return { data };
        },
      },
    },
    path: { get: async () => ({ data: { directory: directory() } }) },
    project: { current: async () => ({ data: null }) },
  }),
};
