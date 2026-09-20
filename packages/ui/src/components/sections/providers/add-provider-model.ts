import type { PiProviderAddModelDetails } from "@/lib/pi/protocol";

export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
export const PI_DEFAULT_MAX_TOKENS = 16_384;

const THINKING_LEVEL_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingLevelKey = (typeof THINKING_LEVEL_KEYS)[number];

export type AddProviderModelFormInput = {
  modelId: string;
  displayName?: string;
  contextWindowText?: string;
  maxTokensText?: string;
  inputText?: boolean;
  inputImage?: boolean;
  supportsThinking?: boolean;
  thinkingLevelMapText?: string;
};

export type AddProviderModelFieldErrors = {
  modelId?: string;
  displayName?: string;
  contextWindow?: string;
  maxTokens?: string;
  thinkingLevelMap?: string;
};

export type AddProviderModelPayload = PiProviderAddModelDetails;

const positiveInteger = (value: string | undefined): number | undefined => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export function validateThinkingMapText(value: string | undefined): {
  value?: PiProviderAddModelDetails["thinkingLevelMap"];
  error?: string;
} {
  const entries = (value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return {};

  const result: Partial<Record<ThinkingLevelKey, string | null>> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const explicitKey = separator >= 0 ? entry.slice(0, separator).trim() : undefined;
    const key = explicitKey
      ? THINKING_LEVEL_KEYS.find((candidate) => candidate === explicitKey)
      : THINKING_LEVEL_KEYS.find(
          (candidate) => entry === candidate || entry.startsWith(`${candidate}-`),
        );
    if (!key)
      return {
        error:
          "Use off, minimal, low, medium, high, xhigh, or max, optionally as key=value",
      };
    if (Object.prototype.hasOwnProperty.call(result, key))
      return { error: `Only one ${key} value is allowed` };

    let mapped: string | null = entry;
    if (separator >= 0) {
      const encoded = entry.slice(separator + 1).trim();
      if (!encoded) return { error: "Thinking values cannot be empty" };
      if (encoded === "null") {
        mapped = null;
      } else if (encoded.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(encoded);
          if (typeof parsed !== "string") throw new Error("not a string");
          mapped = parsed;
        } catch {
          return { error: "Quoted thinking values must be valid strings" };
        }
      } else {
        mapped = encoded;
      }
    }
    if (mapped !== null && mapped.length > 512)
      return { error: "Thinking values must be 512 characters or fewer" };
    result[key] = mapped;
  }
  return { value: result };
}

export function validateAddProviderModel(input: AddProviderModelFormInput): {
  result?: AddProviderModelPayload;
  errors: AddProviderModelFieldErrors;
} {
  const id = input.modelId.trim();
  const name = (input.displayName ?? "").trim();
  const contextWindow = positiveInteger(input.contextWindowText);
  const maxTokens = positiveInteger(input.maxTokensText);
  const thinking = validateThinkingMapText(input.thinkingLevelMapText);

  const errors: AddProviderModelFieldErrors = {
    ...(!id
      ? { modelId: "Required" }
      : id.length > 512
        ? { modelId: "Use 512 characters or fewer" }
        : {}),
    ...(name.length > 512
      ? { displayName: "Use 512 characters or fewer" }
      : {}),
    ...((input.contextWindowText ?? "").trim() && contextWindow === undefined
      ? { contextWindow: "Enter a positive whole number" }
      : {}),
    ...((input.maxTokensText ?? "").trim() && maxTokens === undefined
      ? { maxTokens: "Enter a positive whole number" }
      : {}),
    ...(thinking.error ? { thinkingLevelMap: thinking.error } : {}),
    ...(thinking.value && !input.supportsThinking
      ? { thinkingLevelMap: "Enable Supports thinking to add thinking levels" }
      : {}),
  };

  if (Object.values(errors).some(Boolean)) return { errors };

  const modalities = [
    ...(input.inputText ? ["text" as const] : []),
    ...(input.inputImage ? ["image" as const] : []),
  ];
  return {
    errors,
    result: {
      id,
      ...(name ? { name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(modalities.length > 0 ? { input: modalities } : {}),
      ...(input.supportsThinking ? { reasoning: true } : {}),
      ...(thinking.value ? { thinkingLevelMap: thinking.value } : {}),
    },
  };
}
