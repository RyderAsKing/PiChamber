import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SettingsGroupTitle,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { runtimeFetch } from '@/lib/runtime-fetch';

const getDisplayModel = (
  storedModel: string | undefined
): { providerId: string; modelId: string } => {
  const parsed = parseModelIdentifier(storedModel);
  if (parsed) {
    return parsed;
  }

  return { providerId: '', modelId: '' };
};

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const setProvider = useConfigStore((state) => state.setProvider);
  const setModel = useConfigStore((state) => state.setModel);
  const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelProviders, setSmallModelProviders] = React.useState<string[] | undefined>();
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: {
          defaultModel?: string;
          defaultVariant?: string;
          smallModelUseDefault?: boolean;
          smallModelOverride?: string;
          walkthroughModelOverride?: string;
        } | null = null;

        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                const raw = settings as Record<string, unknown>;
                data = {
                  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
                  defaultVariant:
                    typeof raw.defaultVariant === 'string'
                      ? (raw.defaultVariant as string)
                      : undefined,
                  smallModelUseDefault: typeof raw.smallModelUseDefault === 'boolean' ? raw.smallModelUseDefault : undefined,
                  smallModelOverride: typeof raw.smallModelOverride === 'string' ? raw.smallModelOverride : undefined,
                  walkthroughModelOverride:
                    typeof raw.walkthroughModelOverride === 'string' ? raw.walkthroughModelOverride : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        if (!data) {
          const response = await runtimeFetch('/api/pi/ui-settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          const model =
            typeof data.defaultModel === 'string' && data.defaultModel.trim().length > 0
              ? data.defaultModel.trim()
              : undefined;
          const variant =
            typeof data.defaultVariant === 'string' && data.defaultVariant.trim().length > 0
              ? data.defaultVariant.trim()
              : undefined;

          if (model !== undefined) setDefaultModel(model);
          if (variant !== undefined) setDefaultVariant(variant);
          if (typeof data.smallModelUseDefault === 'boolean') setSmallModelUseDefault(data.smallModelUseDefault);
          if (typeof data.smallModelOverride === 'string' && data.smallModelOverride.trim()) {
            setSmallModelOverride(data.smallModelOverride.trim());
          }
          if (typeof data.walkthroughModelOverride === 'string' && data.walkthroughModelOverride.trim()) {
            setWalkthroughModelOverride(data.walkthroughModelOverride.trim());
          }
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  const handleModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setDefaultModel(newValue);
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      setCurrentVariant(undefined);
      setSettingsDefaultModel(newValue);

      if (providerId && modelId) {
        const provider = providers.find((p) => p.id === providerId);
        if (provider) {
          setProvider(providerId);
          setModel(modelId);
        }
      }

      try {
        await updateDesktopSettings({ defaultModel: newValue ?? '', defaultVariant: '' });
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultModel: newValue }),
        });
        if (!response.ok) {
          console.warn('Failed to save default model to server:', response.status, response.statusText);
        }
      } catch (error) {
        console.warn('Failed to save default model:', error);
      }
    },
    [providers, setCurrentVariant, setModel, setProvider, setSettingsDefaultModel, setSettingsDefaultVariant]
  );

  const DEFAULT_VARIANT_VALUE = '__default__';

  const formatVariantLabel = React.useCallback((variant: string) => {
    if (variant === DEFAULT_VARIANT_VALUE) {
      return t('settings.pichamber.defaults.option.default');
    }
    return variant.charAt(0).toUpperCase() + variant.slice(1);
  }, [t]);

  const handleVariantChange = React.useCallback(
    async (variant: string) => {
      const newValue = variant === DEFAULT_VARIANT_VALUE ? undefined : variant || undefined;
      setDefaultVariant(newValue);
      setSettingsDefaultVariant(newValue);
      setCurrentVariant(newValue);

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [setCurrentVariant, setSettingsDefaultVariant]
  );

  const handleSmallModelUseDefaultChange = React.useCallback(
    async (useDefault: boolean) => {
      setSmallModelUseDefault(useDefault);
      try {
        await updateDesktopSettings({ smallModelUseDefault: useDefault });
      } catch (error) {
        console.warn('Failed to save small model preference:', error);
      }
    },
    []
  );

  const handleSmallModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setSmallModelOverride(newValue);
      try {
        await updateDesktopSettings({ smallModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      }
    },
    []
  );

  const handleWalkthroughModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setWalkthroughModelOverride(newValue);
      try {
        await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model override:', error);
      }
    },
    []
  );

  const isStructuredOutputCapable = React.useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  const parsedSmallModel = React.useMemo(() => getDisplayModel(smallModelOverride), [smallModelOverride]);
  const parsedWalkthroughModel = React.useMemo(
    () => getDisplayModel(walkthroughModelOverride),
    [walkthroughModelOverride]
  );

  React.useEffect(() => {
    if (smallModelProviders !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setSmallModelProviders(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // leave undefined
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [smallModelProviders]);

  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === parsedModel.modelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return [];
    return Object.keys(variants);
  }, [parsedModel.modelId, parsedModel.providerId, providers]);

  const supportsVariants = availableVariants.length > 0;

  React.useEffect(() => {
    if (!supportsVariants && defaultVariant) {
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      setCurrentVariant(undefined);
      updateDesktopSettings({ defaultVariant: '' }).catch(() => {
        // best effort
      });
    }
  }, [defaultVariant, setCurrentVariant, setSettingsDefaultVariant, supportsVariants]);

  if (isLoading) {
    return null;
  }

  const modelOptions = providers.flatMap((p) =>
    (p.models ?? []).map((m: { id?: string; name?: string }) => {
      const modelId = String(m?.id ?? '');
      const providerId = String(p.id ?? '');
      const modelName = String(m?.name ?? modelId);
      const providerName = String(p.name ?? providerId);
      return {
        value: `${providerId}/${modelId}`,
        label: `${providerName} - ${modelName}`,
        providerId,
        modelId,
      };
    })
  );

  return (
    <>
      <SettingsSection title={t('settings.pichamber.defaults.title')} divider={false}>
        <div className="space-y-0">
          <div className="mt-0 mb-1 typography-meta text-muted-foreground">
            {t('settings.pichamber.defaults.summaryPrefix')}
            {' '}
            {parsedModel.providerId ? (
              <span className="text-foreground">
                {parsedModel.providerId}/{parsedModel.modelId}
                {supportsVariants ? ` (${defaultVariant ?? t('settings.pichamber.defaults.option.defaultLowercase')})` : ''}
              </span>
            ) : (
              <span className="text-foreground">{t('settings.pichamber.defaults.option.default')}</span>
            )}
          </div>

          <div>
            <SettingsFieldRow
              settingsItem="sessions.default-model"
              label={t('settings.pichamber.defaults.field.defaultModel')}
            >
              <Select
                value={parsedModel.providerId && parsedModel.modelId ? `${parsedModel.providerId}/${parsedModel.modelId}` : '__none__'}
                onValueChange={(val) => {
                  if (val === '__none__') {
                    void handleModelChange('', '');
                  } else {
                    const slash = val.indexOf('/');
                    void handleModelChange(val.slice(0, slash), val.slice(slash + 1));
                  }
                }}
              >
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue placeholder={t('settings.pichamber.defaults.option.default')}>
                    {parsedModel.providerId && parsedModel.modelId ? `${parsedModel.providerId}/${parsedModel.modelId}` : t('settings.pichamber.defaults.option.default')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('settings.pichamber.defaults.option.default')}</SelectItem>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>

            <SettingsFieldRow
              settingsItem="sessions.default-thinking"
              label={t('settings.pichamber.defaults.field.defaultThinking')}
            >
              <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue placeholder={t('settings.pichamber.defaults.field.thinkingPlaceholder')}>
                    {formatVariantLabel(defaultVariant ?? DEFAULT_VARIANT_VALUE)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VARIANT_VALUE}>{t('settings.pichamber.defaults.option.default')}</SelectItem>
                  {availableVariants.map((variant) => (
                    <SelectItem key={variant} value={variant}>
                      {formatVariantLabel(variant)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>
          </div>

          <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
            <SettingsCheckboxRow
              settingsItem="sessions.deletion-dialog"
              checked={showDeletionDialog}
              onChange={setShowDeletionDialog}
              label={t('settings.pichamber.defaults.field.showDeletionDialog')}
              ariaLabel={t('settings.pichamber.defaults.field.showDeletionDialogAria')}
            />
          </SettingsInset>

          <div className="space-y-3 pt-6">
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>
                {t('settings.pichamber.defaults.smallModel.title')}
              </SettingsGroupTitle>
              <SettingsInfoHint>
                {t('settings.pichamber.defaults.smallModel.description')}
              </SettingsInfoHint>
            </div>

            <SettingsCheckboxRow
              settingsItem="sessions.small-model"
              checked={smallModelUseDefault}
              onChange={(checked) => {
                void handleSmallModelUseDefaultChange(checked);
              }}
              label={t('settings.pichamber.defaults.smallModel.useDefault')}
              ariaLabel={t('settings.pichamber.defaults.smallModel.useDefaultAria')}
            />

            {!smallModelUseDefault ? (
              <SettingsFieldRow label={t('settings.pichamber.defaults.smallModel.overrideModel')}>
                <Select
                  value={parsedSmallModel.providerId && parsedSmallModel.modelId ? `${parsedSmallModel.providerId}/${parsedSmallModel.modelId}` : '__none__'}
                  onValueChange={(val) => {
                    if (val === '__none__') {
                      void handleSmallModelOverrideChange('', '');
                    } else {
                      const slash = val.indexOf('/');
                      void handleSmallModelOverrideChange(val.slice(0, slash), val.slice(slash + 1));
                    }
                  }}
                >
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                    <SelectValue placeholder={t('settings.pichamber.defaults.option.default')}>
                      {parsedSmallModel.providerId && parsedSmallModel.modelId ? `${parsedSmallModel.providerId}/${parsedSmallModel.modelId}` : t('settings.pichamber.defaults.option.default')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t('settings.pichamber.defaults.option.default')}</SelectItem>
                    {modelOptions
                      .filter((opt) => !smallModelProviders || smallModelProviders.includes(opt.providerId))
                      .map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            ) : null}

            <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
              <div className="flex items-center gap-1.5">
                <SettingsGroupTitle>
                  {t('settings.pichamber.defaults.walkthroughModel.title')}
                </SettingsGroupTitle>
                <SettingsInfoHint>
                  {t('settings.pichamber.defaults.walkthroughModel.description')}
                </SettingsInfoHint>
              </div>

              <SettingsFieldRow
                settingsItem="sessions.walkthrough-model"
                label={t('settings.pichamber.defaults.walkthroughModel.overrideModel')}
              >
                <Select
                  value={parsedWalkthroughModel.providerId && parsedWalkthroughModel.modelId ? `${parsedWalkthroughModel.providerId}/${parsedWalkthroughModel.modelId}` : '__none__'}
                  onValueChange={(val) => {
                    if (val === '__none__') {
                      void handleWalkthroughModelOverrideChange('', '');
                    } else {
                      const slash = val.indexOf('/');
                      void handleWalkthroughModelOverrideChange(val.slice(0, slash), val.slice(slash + 1));
                    }
                  }}
                >
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                    <SelectValue placeholder={t('settings.pichamber.defaults.walkthroughModel.usesSmallModel')}>
                      {parsedWalkthroughModel.providerId && parsedWalkthroughModel.modelId ? `${parsedWalkthroughModel.providerId}/${parsedWalkthroughModel.modelId}` : t('settings.pichamber.defaults.walkthroughModel.usesSmallModel')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t('settings.pichamber.defaults.walkthroughModel.usesSmallModel')}</SelectItem>
                    {modelOptions
                      .filter((opt) => (!smallModelProviders || smallModelProviders.includes(opt.providerId)) && isStructuredOutputCapable(opt.providerId, opt.modelId))
                      .map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            </SettingsInset>
          </div>
        </div>
      </SettingsSection>
    </>
  );
};
