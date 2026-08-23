import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Radio } from '@/components/ui/radio';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

interface ModelStatus {
  id: string;
  description: string;
  sizeBytes: number;
  installed: boolean;
  corrupt: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  downloadError: string | null;
}
interface PublicProvider { id: string; label: string; baseUrl: string; model: string; apiKeyConfigured: boolean }
interface SttConfig { enabled: boolean; providerConfigId: string; language: string; localModelId: string; providers: PublicProvider[] }
interface SttStatus { config: SttConfig; models: ModelStatus[] }

const REMOTE_ID = 'openai-compatible';
const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

export function DictationSettings() {
  const [status, setStatus] = React.useState<SttStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = React.useState('');
  const [remoteModel, setRemoteModel] = React.useState('');
  const [remoteApiKey, setRemoteApiKey] = React.useState('');
  const [busyModel, setBusyModel] = React.useState<string | null>(null);
  const [savingRemote, setSavingRemote] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const response = await runtimeFetch('/api/stt/status');
    if (!response.ok) throw new Error('Could not load dictation settings');
    const next = await response.json() as SttStatus;
    setStatus(next);
    setLoadError(null);
    const remote = next.config.providers.find((entry) => entry.id === REMOTE_ID);
    if (remote) {
      setRemoteUrl(remote.baseUrl);
      setRemoteModel(remote.model);
    }
  }, []);

  React.useEffect(() => { void refresh().catch((error) => setLoadError(error.message)); }, [refresh]);
  React.useEffect(() => {
    if (!status?.models.some((model) => model.downloading)) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, status?.models]);

  const update = React.useCallback(async (changes: Record<string, unknown>) => {
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/stt/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not save dictation settings');
      const payload = await response.json() as { config: SttConfig };
      setStatus((current) => current ? { ...current, config: payload.config } : current);
      reportSettingsSaveState('saved');
    } catch (error) {
      reportSettingsSaveState('error');
      throw error;
    }
  }, []);

  const manageModel = async (modelId: string, method: 'POST' | 'DELETE') => {
    setBusyModel(modelId);
    try {
      const suffix = method === 'POST' ? '/download' : '';
      const response = await runtimeFetch(`/api/stt/models/${encodeURIComponent(modelId)}${suffix}`, { method });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Model action failed');
      await refresh();
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { setBusyModel(null); }
  };

  const saveRemote = async () => {
    setSavingRemote(true);
    try {
      await update({
        remoteProvider: { id: REMOTE_ID, label: 'OpenAI-compatible', baseUrl: remoteUrl, model: remoteModel, apiKey: remoteApiKey || undefined },
        providerConfigId: REMOTE_ID,
      });
      setRemoteApiKey('');
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { setSavingRemote(false); }
  };

  if (!status) {
    return <SettingsPageLayout title="Dictation"><div className="py-8 typography-ui text-muted-foreground">{loadError || 'Loading dictation settings...'}</div></SettingsPageLayout>;
  }
  const remote = status.config.providers.find((entry) => entry.id === REMOTE_ID);

  return (
    <SettingsPageLayout title="Dictation" description="Record speech and insert the final transcript into the composer.">
      <SettingsSection title="Recording" divider={false} settingsItem="dictation.enabled" contentClassName="space-y-4">
        <SettingsCheckboxRow
          checked={status.config.enabled}
          onChange={(enabled) => void update({ enabled }).catch((error) => setLoadError(error.message))}
          label="Enable dictation"
          ariaLabel="Enable dictation"
          info="Audio streams to the active PiChamber server. PiChamber inserts text only after you choose Done and never sends it automatically."
        />
        <SettingsFieldRow label="Transcription provider" settingsItem="dictation.provider">
          <Select value={status.config.providerConfigId} onValueChange={(providerConfigId) => void update({ providerConfigId }).catch((error) => setLoadError(error.message))}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label="Transcription provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local model</SelectItem>
              <SelectItem value={REMOTE_ID} disabled={!remote}>OpenAI-compatible</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsFieldRow label="Language" info="Optional language code such as en or fr. Leave blank for automatic detection." settingsItem="dictation.language">
          <Input
            value={status.config.language}
            onChange={(event) => setStatus((current) => current ? { ...current, config: { ...current.config, language: event.target.value } } : current)}
            onBlur={() => void update({ language: status.config.language }).catch((error) => setLoadError(error.message))}
            placeholder="Auto-detect"
            className="h-8 w-full max-w-48"
            aria-label="Dictation language"
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection title="Local models" info="Models run only on the active PiChamber server. Downloads use pinned checksums and install atomically." settingsItem="dictation.models" contentClassName="space-y-1">
        {status.models.map((model) => (
          <div key={model.id} className="flex min-h-10 items-center gap-3 py-1.5">
            <Radio
              checked={status.config.localModelId === model.id}
              onChange={() => void update({ localModelId: model.id, providerConfigId: 'local' }).catch((error) => setLoadError(error.message))}
              ariaLabel={`Use ${model.description}`}
            />
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => void update({ localModelId: model.id, providerConfigId: 'local' }).catch((error) => setLoadError(error.message))}
            >
              <span className="block truncate typography-ui-label text-foreground">{model.description}</span>
              <span className="typography-meta text-muted-foreground">{megabytes(model.sizeBytes)}</span>
            </button>
            {model.downloading ? (
              <span className="typography-meta tabular-nums text-muted-foreground">{model.downloadProgress === null ? 'Downloading...' : `Downloading ${model.downloadProgress}%`}</span>
            ) : model.installed ? (
              <>
                <Icon name="check" className="size-4 text-[var(--status-success)]" aria-label="Installed" />
                <Button className={SETTINGS_ICON_BUTTON_CLASS} variant="ghost" size="icon" disabled={busyModel === model.id} onClick={() => void manageModel(model.id, 'DELETE')} title="Delete model" aria-label={`Delete ${model.description}`}>
                  <Icon name="delete-bin" className="size-4" />
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" disabled={busyModel === model.id} onClick={() => void manageModel(model.id, 'POST')}>
                {model.corrupt || model.downloadError ? 'Retry' : 'Download'}
              </Button>
            )}
          </div>
        ))}
      </SettingsSection>

      <SettingsSection title="OpenAI-compatible provider" info="The server stores this configuration. Dictation sockets receive only its ID, never the URL or API key." settingsItem="dictation.remote" contentClassName="space-y-4">
        <SettingsStackedField label="Server URL">
          <Input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://api.openai.com/v1" className="h-8" />
        </SettingsStackedField>
        <SettingsStackedField label="Model">
          <Input value={remoteModel} onChange={(event) => setRemoteModel(event.target.value)} placeholder="whisper-1" className="h-8" />
        </SettingsStackedField>
        <SettingsStackedField label="API key" info={remote?.apiKeyConfigured ? 'A key is already stored. Leave this blank to keep it.' : 'Optional for servers that do not require authentication.'}>
          <Input type="password" value={remoteApiKey} onChange={(event) => setRemoteApiKey(event.target.value)} placeholder={remote?.apiKeyConfigured ? 'Stored key' : 'Optional'} className="h-8" autoComplete="off" />
        </SettingsStackedField>
        <div className={SETTINGS_CONTROL_CLUSTER_CLASS}>
          <Button onClick={() => void saveRemote()} disabled={savingRemote || !remoteUrl.trim() || !remoteModel.trim()}>{savingRemote ? 'Saving...' : 'Save Provider'}</Button>
        </div>
      </SettingsSection>
      {loadError ? <p role="alert" className="pb-6 typography-meta text-[var(--status-error)]">{loadError}</p> : null}
    </SettingsPageLayout>
  );
}
