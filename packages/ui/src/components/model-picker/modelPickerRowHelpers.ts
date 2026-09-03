import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import type { ModelMetadata } from '@/types';

const formatCompactNumber = (value: number) => new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatUsdCurrency = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
}).format(value);

export const getModelDisplayName = (model: Record<string, unknown>) => {
  return getSharedModelDisplayName(model, undefined, { maxLength: 40 });
};

export const formatModelContextTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

export const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatUsdCurrency(value);
};

export const hasTooltipMetadata = (metadata?: ModelMetadata) => {
  if (!metadata) return false;
  return Boolean(
    metadata.tool_call ||
    metadata.reasoning ||
    metadata.cost?.input !== undefined ||
    metadata.cost?.output !== undefined ||
    (metadata.modalities?.input?.length ?? 0) > 0 ||
    (metadata.modalities?.output?.length ?? 0) > 0,
  );
};
