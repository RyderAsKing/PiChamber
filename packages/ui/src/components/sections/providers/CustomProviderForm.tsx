import React from 'react';
import {
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import {
  createEmptyCustomProviderForm,
  createHeaderRow,
  createModelRow,
  isCustomProviderApi,
  validateCustomProvider,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type FieldErrors,
  type HeaderFieldErrors,
  type ModelFieldErrors,
} from './custom-provider-form';
import { CustomProviderModelFields } from './CustomProviderModelFields';

type CustomProviderFormProps = {
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  busy?: boolean;
  mode?: 'create' | 'edit';
  initialValues?: CustomProviderFormState;
  allowExistingAuth?: boolean;
  authFailureHint?: string | null;
  onSubmit: (plan: CustomProviderPersistPlan) => void | Promise<void>;
  onCancel?: () => void;
  onDisconnect?: () => void | Promise<void>;
};

export const CustomProviderForm: React.FC<CustomProviderFormProps> = ({
  existingProviderIDs,
  disabledProviders = [],
  busy = false,
  mode = 'create',
  initialValues,
  allowExistingAuth = false,
  authFailureHint = null,
  onSubmit,
  onCancel,
  onDisconnect,
}) => {
    const isEdit = mode === 'edit';
  const [form, setForm] = React.useState<CustomProviderFormState>(
    () => initialValues ?? createEmptyCustomProviderForm(),
  );
  const [err, setErr] = React.useState<FieldErrors>({});
  const [modelErrors, setModelErrors] = React.useState<ModelFieldErrors[]>([]);
  const [headerErrors, setHeaderErrors] = React.useState<HeaderFieldErrors[]>([]);
  const seededEditProviderIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!initialValues) {
      return;
    }
    // Edit mode: seed once per provider id so parent re-renders (new object
    // identity for the same snapshot) do not wipe in-progress edits.
    if (isEdit && seededEditProviderIdRef.current === initialValues.providerID) {
      return;
    }
    seededEditProviderIdRef.current = isEdit ? initialValues.providerID : null;
    setForm(initialValues);
    setErr({});
    setModelErrors([]);
    setHeaderErrors([]);
  }, [initialValues, isEdit]);

  const setField = (key: keyof Pick<CustomProviderFormState, 'providerID' | 'name' | 'baseURL' | 'apiKey'>, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErr((prev) => ({ ...prev, [key]: undefined }));
  };

  const setModel = <Key extends keyof CustomProviderFormState['models'][number]>(
    index: number,
    key: Key,
    value: CustomProviderFormState['models'][number][Key],
    errorKey?: keyof ModelFieldErrors,
  ) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    if (errorKey) {
      setModelErrors((prev) => {
        const next = [...prev];
        next[index] = { ...(next[index] ?? {}), [errorKey]: undefined };
        return next;
      });
    }
  };

  const setHeader = (index: number, key: 'key' | 'value', value: string) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    setHeaderErrors((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? {}), [key]: undefined };
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    const output = validateCustomProvider({
      form,
      existingProviderIDs,
      disabledProviders,
      editingProviderID: isEdit ? form.providerID : undefined,
      allowExistingAuth: isEdit && allowExistingAuth,
    });
    setErr(output.err);
    setModelErrors(output.models);
    setHeaderErrors(output.headers);
    if (!output.result) {
      return;
    }
    await onSubmit(output.result);
  };

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 @3xl:grid-cols-2 @3xl:gap-x-10">
      <SettingsSection
        divider={false}
        settingsItem="providers.custom"
        className="@3xl:col-span-2"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{"Add a provider with a base URL, API format, credentials, and model list. Saved to Pi so it is available in chat like any other provider."}</p>

        {authFailureHint ? (
          <p className="typography-meta text-[var(--status-warning)]" role="status">
            {authFailureHint}
          </p>
        ) : null}

        <SettingsTwoColumn>
        <SettingsStackedField
          label={"Provider ID"}
          info={"Lowercase letters, numbers, hyphens, and underscores. Used as the Pi provider id."}
        >
          <Input
            value={form.providerID}
            onChange={(event) => setField('providerID', event.target.value)}
            placeholder={"my-provider"}
            className="h-8 rounded-md px-3 font-mono text-xs"
            autoFocus={!isEdit}
            disabled={isEdit || busy}
            aria-invalid={Boolean(err.providerID)}
            aria-label={"Provider ID"}
          />
          {err.providerID ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.providerID}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={"Display name"}
          info={"Shown in the provider and model pickers."}
        >
          <Input
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            placeholder={"My Provider"}
            className="h-8 rounded-md px-3"
            aria-invalid={Boolean(err.name)}
            aria-label={"Display name"}
          />
          {err.name ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.name}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={"Base URL"}
          info={"Provider API base URL. Must start with http:// or https://."}
        >
          <Input
            value={form.baseURL}
            onChange={(event) => setField('baseURL', event.target.value)}
            placeholder={"https://api.example.com/v1"}
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.baseURL)}
            aria-label={"Base URL"}
          />
          {err.baseURL ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.baseURL}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={"API format"}
          info={"Select the request and response format implemented by this provider."}
        >
          <Select
            value={form.api}
            onValueChange={(value) => {
              if (isCustomProviderApi(value)) {
                setForm((prev) => ({ ...prev, api: value }));
              }
            }}
            disabled={busy}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
              aria-label={"API format"}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
              <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
              <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
              <SelectItem value="google-generative-ai">Google Generative AI</SelectItem>
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField
          label={"API key"}
          info={
            isEdit && allowExistingAuth
              ? "Leave blank to keep the existing credential, or enter a new key / {env:VAR_NAME}."
              : "Stored in Pi authentication, not by PiChamber. Use {env:VAR_NAME} to read a key from the environment instead."
          }
        >
          <Input
            type="password"
            value={form.apiKey}
            onChange={(event) => setField('apiKey', event.target.value)}
            placeholder={
              isEdit && allowExistingAuth
                ? "Leave blank to keep existing key"
                : "sk-... or {env:VAR_NAME}"
            }
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.apiKey)}
            aria-label={"API key"}
          />
          {err.apiKey ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.apiKey}</p> : null}
        </SettingsStackedField>
        </SettingsTwoColumn>
      </SettingsSection>

      <SettingsSection
        title={"Models"}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        {form.models.map((model, index) => (
          <CustomProviderModelFields
            key={model.row}
            model={model}
            errors={modelErrors[index]}
            busy={busy}
            removable={form.models.length > 1}
            onChange={(key, value, errorKey) => setModel(index, key, value, errorKey)}
            onRemove={() => {
              if (form.models.length <= 1) return;
              setForm((prev) => ({
                ...prev,
                models: prev.models.filter((_, rowIndex) => rowIndex !== index),
              }));
              setModelErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
            }}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, models: [...prev.models, createModelRow()] }));
            setModelErrors((prev) => [...prev, {}]);
          }}
        >
          {"Add model"}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={"Headers"}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{"Optional request headers sent with every call."}</p>
        {form.headers.map((header, index) => (
          <div key={header.row} className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {"Header name"}
                  </label>
                  <Input
                    value={header.key}
                    onChange={(event) => setHeader(index, 'key', event.target.value)}
                    placeholder={"X-Custom-Header"}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={"Header name"}
                  />
                  {headerErrors[index]?.key ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.key}</p>
                  ) : null}
                </div>
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {"Header value"}
                  </label>
                  <Input
                    value={header.value}
                    onChange={(event) => setHeader(index, 'value', event.target.value)}
                    placeholder={"value"}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={"Header value"}
                  />
                  {headerErrors[index]?.value ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.value}</p>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                disabled={form.headers.length <= 1}
                onClick={() => {
                  if (form.headers.length <= 1) return;
                  setForm((prev) => ({
                    ...prev,
                    headers: prev.headers.filter((_, rowIndex) => rowIndex !== index),
                  }));
                  setHeaderErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
                }}
                aria-label={"Remove header"}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, headers: [...prev.headers, createHeaderRow()] }));
            setHeaderErrors((prev) => [...prev, {}]);
          }}
        >
          {"Add header"}
        </Button>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-2 py-4 @3xl:col-span-2">
        {onCancel ? (
          <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={onCancel} disabled={busy}>
            {"Back"}
          </Button>
        ) : null}
        {onDisconnect ? (
          <Button
            type="button"
            variant="destructive"
            size="xs"
            className="!font-normal"
            onClick={() => void onDisconnect()}
            disabled={busy}
          >
            {"Disconnect"}
          </Button>
        ) : null}
        <Button type="submit" size="xs" className="!font-normal" disabled={busy}>
          {busy
            ? "Saving..."
            : isEdit
              ? "Update provider"
              : "Save provider"}
        </Button>
      </div>
    </form>
  );
};
