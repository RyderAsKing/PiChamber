import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SettingsControlGroup,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsModelPicker } from '@/components/sections/shared/SettingsModelPicker';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { piClient } from '@/lib/pi/client';
import {
  formatPiModelRef,
  hasLegacyUiModelDefaultsPatch,
  legacyUiModelDefaultsPatch,
  parsePiModelRef,
} from '@/lib/pi/session-defaults';
import {
  catalogThinkingLevels,
  clampThinkingLevel,
  modelHasConfigurableThinking,
  PI_THINKING_LEVEL_LABELS,
  thinkingModelKey,
} from '@/lib/pi/thinking';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { reportSettingsSaveState, updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { PiChamberDefaultsUpdateInput, PiSettingsSnapshot } from '@/lib/pi/protocol';
import type { PiModelRef, PiThinkingLevel } from '@/lib/pi/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const providerScope = () => ({ runtimeKey: getRuntimeKey() });

const FALLBACK_THINKING = '__pi_fallback__';

const thinkingSelectOptions = (levels: PiThinkingLevel[], stored?: PiThinkingLevel) => {
  const options = [...levels];
  if (stored && !options.includes(stored)) options.push(stored);
  return options;
};

export const DefaultsSettings: React.FC = () => {
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const setProvider = useConfigStore((state) => state.setProvider);
  const setModel = useConfigStore((state) => state.setModel);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultThinking = useConfigStore((state) => state.setSettingsDefaultThinking);
  const setSettingsDefaultThinkingByModel = useConfigStore((state) => state.setSettingsDefaultThinkingByModel);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const [pichamber, setPichamber] = React.useState<PiSettingsSnapshot['pichamber'] | null>(null);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'failed'>('loading');

  const applyPichamber = React.useCallback((next: PiSettingsSnapshot['pichamber']) => {
    setPichamber(next);
    setSettingsDefaultModel(formatPiModelRef(next.defaultModel));
    setSettingsDefaultThinking(next.defaultThinking);
    setSettingsDefaultThinkingByModel(next.defaultThinkingByModel ?? {});
  }, [setSettingsDefaultModel, setSettingsDefaultThinking, setSettingsDefaultThinkingByModel]);

  React.useEffect(() => {
    void loadProviders({ source: 'sessionsDefaults' });
  }, [loadProviders]);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const snapshot = await piClient.getSettings(providerScope());
        if (!active) return;
        let next = snapshot.pichamber;
        if (!next.defaultModel && !next.smallModel && !next.walkthroughModel) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const patch = legacyUiModelDefaultsPatch(result?.settings as Record<string, unknown> | undefined, next);
              if (hasLegacyUiModelDefaultsPatch(patch)) {
                const written = await piClient.setPiChamberDefaults(patch, providerScope());
                if (!active) return;
                next = written.pichamber;
                await updateDesktopSettings({
                  defaultModel: '',
                  smallModelOverride: '',
                  walkthroughModelOverride: '',
                });
              }
            } catch {
              // Sidecar remains the source of truth; desktop leftovers stay until the next successful adopt.
            }
          }
        }
        if (!active) return;
        applyPichamber(next);
        setLoadState('ready');
      } catch {
        if (active) setLoadState('failed');
      }
    };
    void load();
    return () => { active = false; };
  }, [applyPichamber]);

  const persist = React.useCallback(async (patch: PiChamberDefaultsUpdateInput) => {
    reportSettingsSaveState('saving');
    try {
      const result = await piClient.setPiChamberDefaults(patch, providerScope());
      applyPichamber(result.pichamber);
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
    }
  }, [applyPichamber]);

  const findProviderModel = React.useCallback((providerId: string, modelId: string) => {
    const provider = providers.find((entry) => entry.id === providerId);
    const models = Array.isArray(provider?.models) ? provider.models : [];
    return models.find((entry) => entry.id === modelId);
  }, [providers]);

  const handleDefaultModelChange = React.useCallback((model: PiModelRef | null) => {
    if (model) {
      const provider = providers.find((entry) => entry.id === model.providerId);
      if (provider) {
        setProvider(model.providerId);
        setModel(model.modelId);
      }
    }
    void persist({ defaultModel: model });
  }, [persist, providers, setModel, setProvider]);

  const persistThinkingForModel = React.useCallback((model: PiModelRef, level: PiThinkingLevel | null) => {
    const key = thinkingModelKey(model);
    if (!key) return;
    void persist({ defaultThinkingByModel: { [key]: level } });
  }, [persist]);

  const isStructuredOutputCapable = React.useCallback(
    (providerId: string, modelId: string) => modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata],
  );

  const isThinkingModelAllowed = React.useCallback((providerId: string, modelId: string) => {
    const key = `${providerId}/${modelId}`;
    if (pichamber?.defaultThinkingByModel?.[key]) return false;
    if (thinkingModelKey(pichamber?.defaultModel) === key) return false;
    return modelHasConfigurableThinking(catalogThinkingLevels(findProviderModel(providerId, modelId)));
  }, [findProviderModel, pichamber?.defaultModel, pichamber?.defaultThinkingByModel]);

  if (loadState === 'loading') {
    return null;
  }

  if (loadState === 'failed' && !pichamber) {
    return (
      <SettingsSection title="Session Defaults" divider={false}>
        <p className="typography-meta text-[var(--status-error)]">{"Session defaults are unavailable."}</p>
      </SettingsSection>
    );
  }

  const defaultModelKey = thinkingModelKey(pichamber?.defaultModel);
  const defaultModelCatalog = pichamber?.defaultModel
    ? findProviderModel(pichamber.defaultModel.providerId, pichamber.defaultModel.modelId)
    : undefined;
  const defaultThinkingLevels = catalogThinkingLevels(defaultModelCatalog);
  const showDefaultThinking = Boolean(pichamber?.defaultModel && modelHasConfigurableThinking(defaultThinkingLevels));
  const defaultStoredThinking = defaultModelKey
    ? pichamber?.defaultThinkingByModel?.[defaultModelKey]
    : undefined;
  const extraThinkingKeys = Object.keys(pichamber?.defaultThinkingByModel ?? {})
    .filter((key) => key !== defaultModelKey)
    .sort();

  return (
    <SettingsSection
      title="Session Defaults"
      divider={false}
      info="New sessions use these models. Leave a picker on its fallback to keep Pi's own default."
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow
          settingsItem="sessions.default-model"
          label="Default Model"
          info="The model new sessions start with. Unset keeps Pi's default."
        >
          <SettingsModelPicker
            value={pichamber?.defaultModel ?? null}
            noneLabel="Default"
            ariaLabel="Default model"
            onChange={handleDefaultModelChange}
          />
        </SettingsFieldRow>

        {showDefaultThinking && pichamber?.defaultModel ? (
          <SettingsFieldRow
            settingsItem="sessions.default-thinking"
            label="Default Thinking"
            info="Thinking level for new sessions that start with the default model. Unset keeps Pi's default for that model."
          >
            <Select
              value={defaultStoredThinking ?? FALLBACK_THINKING}
              onValueChange={(value) => {
                persistThinkingForModel(
                  pichamber.defaultModel!,
                  value === FALLBACK_THINKING ? null : value as PiThinkingLevel,
                );
              }}
            >
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label="Default thinking">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FALLBACK_THINKING}>{"Default"}</SelectItem>
                {thinkingSelectOptions(defaultThinkingLevels, defaultStoredThinking).map((level) => (
                  <SelectItem key={level} value={level}>{PI_THINKING_LEVEL_LABELS[level]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        ) : null}

        <SettingsFieldRow
          settingsItem="sessions.small-model"
          label="Small Model"
          info="A cheap model for quick utility tasks like short recaps and summaries."
        >
          <SettingsModelPicker
            value={pichamber?.smallModel ?? null}
            noneLabel="Use default small model"
            ariaLabel="Small model"
            onChange={(model) => { void persist({ smallModel: model }); }}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.walkthrough-model"
          label="Changes Walkthrough Model"
          info="The AI review of your changes needs structured output and room for a whole diff, which a cheap small model often cannot give. Models the catalog reports as unable to produce structured output are hidden from this picker. Leave it unset and the small model is used."
        >
          <SettingsModelPicker
            value={pichamber?.walkthroughModel ?? null}
            noneLabel="Small model"
            ariaLabel="Changes walkthrough model"
            isModelAllowed={isStructuredOutputCapable}
            onChange={(model) => { void persist({ walkthroughModel: model }); }}
          />
        </SettingsFieldRow>

        <SettingsControlGroup
          settingsItem="sessions.thinking-defaults"
          title="Thinking defaults"
          info="Per-model thinking for new sessions and composer model changes. Models that only support Off are hidden."
        >
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {extraThinkingKeys.map((key) => {
              const model = parsePiModelRef(key);
              if (!model) return null;
              const catalogModel = findProviderModel(model.providerId, model.modelId);
              const levels = catalogThinkingLevels(catalogModel);
              const stored = pichamber?.defaultThinkingByModel?.[key];
              const label = getModelDisplayName(catalogModel, model.modelId);
              return (
                <SettingsFieldRow
                  key={key}
                  label={label}
                  controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
                >
                  <Select
                    value={stored ?? levels[0] ?? 'off'}
                    onValueChange={(value) => {
                      persistThinkingForModel(model, value as PiThinkingLevel);
                    }}
                  >
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={`Thinking for ${label}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {thinkingSelectOptions(levels, stored).map((level) => (
                        <SelectItem key={level} value={level}>{PI_THINKING_LEVEL_LABELS[level]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={SETTINGS_ICON_BUTTON_CLASS}
                    aria-label={`Remove thinking default for ${label}`}
                    onClick={() => { persistThinkingForModel(model, null); }}
                  >
                    <Icon name="delete-bin" className="size-4" />
                  </Button>
                </SettingsFieldRow>
              );
            })}
            <SettingsFieldRow
              label="Add model"
              info="Pick a thinking-capable model to store a default level for it."
            >
              <SettingsModelPicker
                value={null}
                noneLabel="Add model"
                ariaLabel="Add thinking default"
                isModelAllowed={isThinkingModelAllowed}
                onChange={(model) => {
                  if (!model) return;
                  const levels = catalogThinkingLevels(findProviderModel(model.providerId, model.modelId));
                  persistThinkingForModel(model, clampThinkingLevel(levels, 'medium'));
                }}
              />
            </SettingsFieldRow>
          </div>
        </SettingsControlGroup>

        <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.deletion-dialog"
            checked={showDeletionDialog}
            onChange={setShowDeletionDialog}
            label="Show Deletion Dialog"
            ariaLabel="Show deletion dialog"
          />
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
