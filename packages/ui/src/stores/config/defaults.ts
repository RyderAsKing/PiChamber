import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { parsePiThinkingLevel } from '@/lib/pi/thinking';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { markStartupTrace } from '@/lib/startupTrace';

export interface PiChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultThinking?: string;
    defaultThinkingByModel?: Record<string, string>;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
}

const parseSidecarThinkingByModel = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: Record<string, string> = {};
    for (const [key, level] of Object.entries(value)) {
        if (!parseModelIdentifier(key)) continue;
        const parsed = parsePiThinkingLevel(level);
        if (!parsed) continue;
        result[key] = parsed;
    }
    return result;
};

const loadSidecarDefaults = async (): Promise<{
    ok: false;
} | {
    ok: true;
    defaultModel?: string;
    defaultThinking?: string;
    defaultThinkingByModel?: Record<string, string>;
}> => {
    try {
        const response = await runtimeFetch('/api/pi/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            return { ok: false };
        }
        const data = await response.json();
        const pichamber = data?.pichamber;
        const model = pichamber?.defaultModel;
        let defaultModel: string | undefined;
        if (model && typeof model.providerId === 'string' && typeof model.modelId === 'string') {
            const providerId = model.providerId.trim();
            const modelId = model.modelId.trim();
            if (providerId && modelId) defaultModel = `${providerId}/${modelId}`;
        }
        return {
            ok: true,
            defaultModel,
            defaultThinking: parsePiThinkingLevel(pichamber?.defaultThinking) ?? undefined,
            defaultThinkingByModel: parseSidecarThinkingByModel(pichamber?.defaultThinkingByModel),
        };
    } catch {
        return { ok: false };
    }
};

export const fetchPiChamberDefaults = async (): Promise<PiChamberDefaults> => {
    markStartupTrace('config.defaults:start');
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const finish = (source: string, result: PiChamberDefaults) => {
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('config.defaults:end', {
            source,
            durationMs: Math.round(ended - started),
            hasDefaultModel: Boolean(result.defaultModel),
        });
        return result;
    };
    try {
        const sidecarDefaults = await loadSidecarDefaults();
        const withSidecarModel = (source: string, result: PiChamberDefaults): PiChamberDefaults => {
            if (!sidecarDefaults.ok) {
                return finish(source, result);
            }
            return finish(source, {
                ...result,
                defaultModel: sidecarDefaults.defaultModel,
                defaultThinking: sidecarDefaults.defaultThinking,
                defaultThinkingByModel: sidecarDefaults.defaultThinkingByModel,
            });
        };

        // 1. Runtime settings API (desktop/embedded surfaces)
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
            try {
                const result = await runtimeSettings.load();
                const data = result?.settings;
                if (data) {
                    const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
                    const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
                    const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
                    const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
                    const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
                    const messageStreamTransport =
                        data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                            ? data.messageStreamTransport
                            : undefined;

                    return withSidecarModel('runtime-settings', {
                        defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
                        defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
                        autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
                        gitmojiEnabled,
                        defaultFileViewerPreview,
                        zenModel: zenModel.length > 0 ? zenModel : undefined,
                        messageStreamTransport,
                    });
                }
            } catch {
                // Fall through to fetch
            }
        }

        // 2. Fetch API (Web/server)
        const response = await runtimeFetch('/api/pi/ui-settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            return withSidecarModel('settings-route-not-ok', {});
        }
        const data = await response.json();
        const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
        const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
        const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
        const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
        const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
        const messageStreamTransport =
            data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                ? data.messageStreamTransport
                : undefined;

        return withSidecarModel('settings-route', {
            defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
            defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
            autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
            gitmojiEnabled,
            defaultFileViewerPreview,
            zenModel: zenModel.length > 0 ? zenModel : undefined,
            messageStreamTransport,
        });
    } catch (error) {
        markStartupTrace('config.defaults:error', { error: error instanceof Error ? error.message : String(error) });
        return finish('error', {});
    }
};

