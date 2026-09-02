import React from 'react';

export function useStickyDisplayValue<T>(
  value: T | null | undefined
): T | null | undefined {
  const [stickyValue, setStickyValue] = React.useState<T | null | undefined>(
    value
  );

  React.useEffect(() => {
    if (value !== undefined && value !== null) {
      setStickyValue(value);
    }
  }, [value]);

  return value ?? stickyValue;
}

export const getMessageInfoProp = (info: unknown, key: string): unknown => {
  if (typeof info === 'object' && info !== null) {
    return (info as Record<string, unknown>)[key];
  }
  return undefined;
};

export const readNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Pi stores provider/model on `info.model`; older records used top-level ids. */
export const getMessageModelRef = (
  info: unknown
): { providerId?: string; modelId?: string } => {
  const nested = getMessageInfoProp(info, 'model');
  const nestedRecord =
    typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)
      : null;
  return {
    providerId:
      readNonEmptyString(getMessageInfoProp(info, 'providerID')) ??
      readNonEmptyString(nestedRecord?.providerID) ??
      readNonEmptyString(nestedRecord?.providerId),
    modelId:
      readNonEmptyString(getMessageInfoProp(info, 'modelID')) ??
      readNonEmptyString(nestedRecord?.modelID) ??
      readNonEmptyString(nestedRecord?.modelId),
  };
};
