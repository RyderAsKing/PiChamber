import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SettingsCheckboxRow,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
} from "@/components/sections/shared/SettingsSection";
import { SettingsInfoHint } from "@/components/sections/shared/SettingsInfoHint";
import { Icon } from "@/components/icon/Icon";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui";
import { piClient } from "@/lib/pi/client";
import {
  deferredSettingsMessage,
  isDeferredPiMutation,
} from "@/lib/pi/mutation-status";
import { providerScope } from "./providerModelHelpers";
import {
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_TOKENS,
  validateAddProviderModel,
  type AddProviderModelFieldErrors,
  type AddProviderModelPayload,
} from "./add-provider-model";
import { ThinkingLevelsInput } from "./ThinkingLevelsInput";

interface AddProviderModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerLabel: string;
  /** Test-only initial disclosure state. Defaults to collapsed. */
  initialAdvancedOpen?: boolean;
  /**
   * Called after a successful add with its identity and deferred recreation
   * status so the parent can refresh immediately or wait for that model to
   * appear after idle-edge activation.
   */
  onAdded?: (result: { deferred: boolean; providerId: string; modelId: string }) => void | Promise<void>;
}

const mapAddError = (error: unknown): string => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code === "INVALID_ARGUMENT") {
    return "Could not add this model. It may already exist, or this provider cannot accept manual models.";
  }
  if (code === "PROVIDER_NOT_FOUND") {
    return "This provider is no longer available. Refresh providers and try again.";
  }
  if (code === "PI_MODEL_CONFIG_INVALID") {
    return "Pi model configuration is invalid.";
  }
  if (code) {
    return `Could not add model (${code}). Try again.`;
  }
  return "Could not add model. Try again.";
};

/**
 * Manual single-model append for one provider. Only Model ID is visible
 * initially; Display name and every other optional setting live under a
 * collapsed Advanced settings disclosure. Empty optionals are omitted so Pi
 * fills its own defaults (name falls back to id, context 128000, max output
 * 16384, input text, and reasoning false).
 */
export const AddProviderModelDialog: React.FC<AddProviderModelDialogProps> = ({
  open,
  onOpenChange,
  providerId,
  providerLabel,
  onAdded,
  initialAdvancedOpen = false,
}) => {
  const [modelId, setModelId] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [contextWindowText, setContextWindowText] = React.useState("");
  const [maxTokensText, setMaxTokensText] = React.useState("");
  const [inputText, setInputText] = React.useState(false);
  const [inputImage, setInputImage] = React.useState(false);
  const [supportsThinking, setSupportsThinking] = React.useState(false);
  const [thinkingLevelMapText, setThinkingLevelMapText] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(initialAdvancedOpen);
  const [fieldErrors, setFieldErrors] =
    React.useState<AddProviderModelFieldErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setModelId("");
    setDisplayName("");
    setContextWindowText("");
    setMaxTokensText("");
    setInputText(false);
    setInputImage(false);
    setSupportsThinking(false);
    setThinkingLevelMapText("");
    setAdvancedOpen(initialAdvancedOpen);
    setFieldErrors({});
    setSubmitError(null);
    setSaving(false);
  }, [open, providerId, initialAdvancedOpen]);

  const handleOpenChange = (next: boolean) => {
    if (saving && !next) return;
    onOpenChange(next);
  };

  const clearError = (key: keyof AddProviderModelFieldErrors) => {
    setFieldErrors((prev) =>
      prev[key] === undefined ? prev : { ...prev, [key]: undefined },
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;

    const validated = validateAddProviderModel({
      modelId,
      displayName,
      contextWindowText,
      supportsThinking,
      maxTokensText,
      inputText,
      inputImage,
      thinkingLevelMapText,
    });
    setFieldErrors(validated.errors);
    const payload: AddProviderModelPayload | undefined = validated.result;
    if (!payload) {
      if (
        validated.errors.displayName
        || validated.errors.contextWindow
        || validated.errors.maxTokens
        || validated.errors.thinkingLevelMap
      ) {
        setAdvancedOpen(true);
      }
      setSubmitError(null);
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      const response = await piClient.addProviderModel(
        { providerId, model: payload },
        providerScope(),
      );
      const deferred = isDeferredPiMutation(response);
      if (deferred) {
        toast.info(deferredSettingsMessage("Model"));
      } else {
        toast.success("Model added");
      }
      onOpenChange(false);
      await onAdded?.({ deferred, providerId, modelId: payload.id });
    } catch (error) {
      setSubmitError(mapAddError(error));
    } finally {
      setSaving(false);
    }
  };

  const describedBy = (
    hintId: string,
    errorId: string,
    hasError: boolean,
  ): string => (hasError ? `${hintId} ${errorId}` : hintId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          advancedOpen ? "max-w-3xl" : "max-w-md",
          "w-full @container p-4 sm:p-6",
        )}
      >
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            {`Add a manual model to ${providerLabel}. Only the Model ID is required.`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="@container space-y-4 py-2">
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <label
                className={SETTINGS_FIELD_LABEL_CLASS}
                htmlFor="add-model-id"
              >
                Model ID
              </label>
              <span className="text-xs text-[var(--status-error)]" aria-hidden>
                *
              </span>
            </div>
            <Input
              id="add-model-id"
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value);
                clearError("modelId");
              }}
              placeholder="my-model"
              className="h-8 font-mono text-xs"
              autoFocus
              disabled={saving}
              aria-invalid={Boolean(fieldErrors.modelId) || undefined}
              aria-describedby={
                fieldErrors.modelId ? "add-model-id-error" : undefined
              }
              aria-label="Model ID"
              aria-required="true"
            />
            {fieldErrors.modelId ? (
              <p
                id="add-model-id-error"
                role="alert"
                className="mt-1 typography-meta text-[var(--status-error)]"
              >
                {fieldErrors.modelId}
              </p>
            ) : null}
          </div>

          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              id="add-model-advanced-toggle"
              aria-expanded={advancedOpen}
              aria-controls="add-model-advanced"
              onClick={() => setAdvancedOpen((current) => !current)}
              className="w-full justify-between px-0"
            >
              <span>Advanced settings</span>
              <Icon
                name="arrow-down-s"
                className={cn(
                  "size-4 transition-transform",
                  advancedOpen && "rotate-180",
                )}
                aria-hidden
              />
            </Button>
            {advancedOpen ? (
              <div
                id="add-model-advanced"
                role="region"
                aria-labelledby="add-model-advanced-toggle"
                className="grid grid-cols-1 gap-4 border-t border-border/60 pt-4 @xl:grid-cols-2"
              >
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label
                      className={SETTINGS_FIELD_LABEL_CLASS}
                      htmlFor="add-model-label"
                    >
                      Display name
                    </label>
                    <SettingsInfoHint contentClassName="max-w-xs">
                      Shown in pickers.
                    </SettingsInfoHint>
                  </div>
                  <Input
                    id="add-model-label"
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      clearError("displayName");
                    }}
                    placeholder="Same as Model ID"
                    className="h-8"
                    disabled={saving}
                    aria-invalid={Boolean(fieldErrors.displayName) || undefined}
                    aria-describedby={describedBy(
                      "add-model-label-hint",
                      "add-model-label-error",
                      Boolean(fieldErrors.displayName),
                    )}
                    aria-label="Display name"
                  />
                  <p
                    id="add-model-label-hint"
                    className={cn(SETTINGS_HELPER_CLASS, "mt-1")}
                  >
                    Defaults to the Model ID. Leave empty to omit.
                  </p>
                  {fieldErrors.displayName ? (
                    <p
                      id="add-model-label-error"
                      role="alert"
                      className="mt-1 typography-meta text-[var(--status-error)]"
                    >
                      {fieldErrors.displayName}
                    </p>
                  ) : null}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label
                      className={SETTINGS_FIELD_LABEL_CLASS}
                      htmlFor="add-model-context"
                    >
                      Context window
                    </label>
                  </div>
                  <Input
                    id="add-model-context"
                    value={contextWindowText}
                    onChange={(event) => {
                      setContextWindowText(event.target.value);
                      clearError("contextWindow");
                    }}
                    placeholder={String(PI_DEFAULT_CONTEXT_WINDOW)}
                    inputMode="numeric"
                    className="h-8 font-mono text-xs"
                    disabled={saving}
                    aria-invalid={
                      Boolean(fieldErrors.contextWindow) || undefined
                    }
                    aria-describedby={describedBy(
                      "add-model-context-hint",
                      "add-model-context-error",
                      Boolean(fieldErrors.contextWindow),
                    )}
                    aria-label="Context window"
                  />
                  <p
                    id="add-model-context-hint"
                    className={cn(SETTINGS_HELPER_CLASS, "mt-1")}
                  >
                    {`Pi uses ${PI_DEFAULT_CONTEXT_WINDOW.toLocaleString()} when empty.`}
                  </p>
                  {fieldErrors.contextWindow ? (
                    <p
                      id="add-model-context-error"
                      role="alert"
                      className="mt-1 typography-meta text-[var(--status-error)]"
                    >
                      {fieldErrors.contextWindow}
                    </p>
                  ) : null}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <label
                      className={SETTINGS_FIELD_LABEL_CLASS}
                      htmlFor="add-model-max-tokens"
                    >
                      Max output tokens
                    </label>
                  </div>
                  <Input
                    id="add-model-max-tokens"
                    value={maxTokensText}
                    onChange={(event) => {
                      setMaxTokensText(event.target.value);
                      clearError("maxTokens");
                    }}
                    placeholder={String(PI_DEFAULT_MAX_TOKENS)}
                    inputMode="numeric"
                    className="h-8 font-mono text-xs"
                    disabled={saving}
                    aria-invalid={Boolean(fieldErrors.maxTokens) || undefined}
                    aria-describedby={describedBy(
                      "add-model-max-tokens-hint",
                      "add-model-max-tokens-error",
                      Boolean(fieldErrors.maxTokens),
                    )}
                    aria-label="Max output tokens"
                  />
                  <p
                    id="add-model-max-tokens-hint"
                    className={cn(SETTINGS_HELPER_CLASS, "mt-1")}
                  >
                    {`Pi uses ${PI_DEFAULT_MAX_TOKENS.toLocaleString()} when empty.`}
                  </p>
                  {fieldErrors.maxTokens ? (
                    <p
                      id="add-model-max-tokens-error"
                      role="alert"
                      className="mt-1 typography-meta text-[var(--status-error)]"
                    >
                      {fieldErrors.maxTokens}
                    </p>
                  ) : null}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span
                      className={SETTINGS_FIELD_LABEL_CLASS}
                      id="add-model-input-label"
                    >
                      Input modalities
                    </span>
                    <SettingsInfoHint contentClassName="max-w-xs">
                      Select one or both; leave both off to omit.
                    </SettingsInfoHint>
                  </div>
                  <div
                    role="group"
                    aria-labelledby="add-model-input-label"
                    aria-describedby="add-model-input-hint"
                    className="space-y-1.5"
                  >
                    <SettingsCheckboxRow
                      checked={inputText}
                      onChange={(next) => setInputText(next)}
                      label="Text"
                      ariaLabel="Text input"
                      disabled={saving}
                    />
                    <SettingsCheckboxRow
                      checked={inputImage}
                      onChange={(next) => setInputImage(next)}
                      label="Image"
                      ariaLabel="Image input"
                      disabled={saving}
                    />
                  </div>
                  <p
                    id="add-model-input-hint"
                    className={cn(SETTINGS_HELPER_CLASS, "mt-1")}
                  >
                    Defaults to text when omitted.
                  </p>
                </div>

                <div className="space-y-2 @xl:col-span-2">
                  <SettingsCheckboxRow
                    checked={supportsThinking}
                    onChange={(next) => {
                      setSupportsThinking(next);
                      clearError("thinkingLevelMap");
                    }}
                    label="Supports thinking"
                    ariaLabel="Supports thinking"
                    disabled={saving}
                    info="Pi defaults to off. Checked sends true; unchecked omits the field."
                  />

                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <label
                        className={SETTINGS_FIELD_LABEL_CLASS}
                        htmlFor="add-model-thinking-map"
                      >
                        Thinking levels
                      </label>
                    </div>
                    <ThinkingLevelsInput
                      id="add-model-thinking-map"
                      value={thinkingLevelMapText}
                      onChange={(value) => {
                        setThinkingLevelMapText(value);
                        clearError("thinkingLevelMap");
                      }}
                      disabled={saving || !supportsThinking}
                      hasError={Boolean(fieldErrors.thinkingLevelMap)}
                    />
                    <p
                      id="add-model-thinking-map-hint"
                      className={cn(SETTINGS_HELPER_CLASS, "mt-1")}
                    >
                      Requires Supports thinking.
                    </p>
                    {fieldErrors.thinkingLevelMap ? (
                      <p
                        id="add-model-thinking-map-error"
                        role="alert"
                        className="mt-1 typography-meta text-[var(--status-error)]"
                      >
                        {fieldErrors.thinkingLevelMap}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {submitError ? (
            <p
              className="typography-meta text-[var(--status-error)]"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Adding…" : "Add model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
