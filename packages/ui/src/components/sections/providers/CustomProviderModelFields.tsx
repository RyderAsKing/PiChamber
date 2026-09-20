import React from "react";
import { Icon } from "@/components/icon/Icon";
import {
  SettingsCheckboxRow,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
} from "@/components/sections/shared/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_TOKENS,
  type AddProviderModelFieldErrors,
} from "./add-provider-model";
import type { ModelRow } from "./custom-provider-form";
import { ThinkingLevelsInput } from "./ThinkingLevelsInput";

type Props = {
  model: ModelRow;
  errors?: AddProviderModelFieldErrors;
  busy: boolean;
  removable: boolean;
  onChange: <Key extends keyof ModelRow>(
    key: Key,
    value: ModelRow[Key],
    errorKey?: keyof AddProviderModelFieldErrors,
  ) => void;
  onRemove: () => void;
};

const ErrorText = ({ children }: { children?: string }) =>
  children ? (
    <p role="alert" className="mt-1 typography-meta text-[var(--status-error)]">
      {children}
    </p>
  ) : null;

export const CustomProviderModelFields: React.FC<Props> = ({
  model,
  errors,
  busy,
  removable,
  onChange,
  onRemove,
}) => {
  const prefix = `custom-provider-${model.row}`;
  return (
    <div className="space-y-3 border-b border-border/60 pb-4 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <label
              className={SETTINGS_FIELD_LABEL_CLASS}
              htmlFor={`${prefix}-id`}
            >
              Model ID
            </label>
            <Input
              id={`${prefix}-id`}
              value={model.modelId}
              onChange={(event) =>
                onChange("modelId", event.target.value, "modelId")
              }
              placeholder="gpt-4o"
              className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
              disabled={busy}
              aria-invalid={Boolean(errors?.modelId) || undefined}
            />
            <ErrorText>{errors?.modelId}</ErrorText>
          </div>
          <div>
            <label
              className={SETTINGS_FIELD_LABEL_CLASS}
              htmlFor={`${prefix}-name`}
            >
              Display name
            </label>
            <Input
              id={`${prefix}-name`}
              value={model.displayName}
              onChange={(event) =>
                onChange("displayName", event.target.value, "displayName")
              }
              placeholder="Same as Model ID"
              className="mt-1 h-8 rounded-md px-3"
              disabled={busy}
              aria-invalid={Boolean(errors?.displayName) || undefined}
            />
            <ErrorText>{errors?.displayName}</ErrorText>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={SETTINGS_ICON_BUTTON_CLASS}
          disabled={!removable || busy}
          onClick={onRemove}
          aria-label="Remove model"
        >
          <Icon name="delete-bin" className="size-4" />
        </Button>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-between px-0"
        aria-expanded={model.advancedOpen}
        aria-controls={`${prefix}-advanced`}
        onClick={() => onChange("advancedOpen", !model.advancedOpen)}
        disabled={busy}
      >
        <span>Advanced settings</span>
        <Icon
          name="arrow-down-s"
          className={cn(
            "size-4 transition-transform",
            model.advancedOpen && "rotate-180",
          )}
        />
      </Button>

      {model.advancedOpen ? (
        <div
          id={`${prefix}-advanced`}
          className="grid grid-cols-1 gap-3 border-t border-border/60 pt-3 @xl:grid-cols-2"
        >
          <div>
            <label
              className={SETTINGS_FIELD_LABEL_CLASS}
              htmlFor={`${prefix}-context`}
            >
              Context window
            </label>
            <Input
              id={`${prefix}-context`}
              value={model.contextWindowText}
              onChange={(event) =>
                onChange(
                  "contextWindowText",
                  event.target.value,
                  "contextWindow",
                )
              }
              placeholder={String(PI_DEFAULT_CONTEXT_WINDOW)}
              inputMode="numeric"
              className="mt-1 h-8 font-mono text-xs"
              disabled={busy}
              aria-invalid={Boolean(errors?.contextWindow) || undefined}
            />
            <ErrorText>{errors?.contextWindow}</ErrorText>
          </div>
          <div>
            <label
              className={SETTINGS_FIELD_LABEL_CLASS}
              htmlFor={`${prefix}-max`}
            >
              Max output tokens
            </label>
            <Input
              id={`${prefix}-max`}
              value={model.maxTokensText}
              onChange={(event) =>
                onChange("maxTokensText", event.target.value, "maxTokens")
              }
              placeholder={String(PI_DEFAULT_MAX_TOKENS)}
              inputMode="numeric"
              className="mt-1 h-8 font-mono text-xs"
              disabled={busy}
              aria-invalid={Boolean(errors?.maxTokens) || undefined}
            />
            <ErrorText>{errors?.maxTokens}</ErrorText>
          </div>

          <div className="@xl:col-span-2">
            <span className={SETTINGS_FIELD_LABEL_CLASS}>Input modalities</span>
            <div className="mt-1 space-y-1.5">
              <SettingsCheckboxRow
                checked={Boolean(model.inputText)}
                onChange={(value) => onChange("inputText", value)}
                label="Text"
                ariaLabel="Text input"
                disabled={busy}
              />
              <SettingsCheckboxRow
                checked={Boolean(model.inputImage)}
                onChange={(value) => onChange("inputImage", value)}
                label="Image"
                ariaLabel="Image input"
                disabled={busy}
              />
            </div>
          </div>

          <div className="space-y-2 @xl:col-span-2">
            <SettingsCheckboxRow
              checked={Boolean(model.supportsThinking)}
              onChange={(value) =>
                onChange("supportsThinking", value, "thinkingLevelMap")
              }
              label="Supports thinking"
              ariaLabel="Supports thinking"
              disabled={busy}
              info="Pi defaults to off. Unchecked omits this setting."
            />
            <div>
              <label
                className={SETTINGS_FIELD_LABEL_CLASS}
                htmlFor={`${prefix}-thinking`}
              >
                Thinking levels
              </label>
              <ThinkingLevelsInput
                id={`${prefix}-thinking`}
                value={model.thinkingLevelMapText ?? ""}
                onChange={(value) =>
                  onChange("thinkingLevelMapText", value, "thinkingLevelMap")
                }
                disabled={busy || !model.supportsThinking}
                hasError={Boolean(errors?.thinkingLevelMap)}
              />
              <ErrorText>{errors?.thinkingLevelMap}</ErrorText>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
