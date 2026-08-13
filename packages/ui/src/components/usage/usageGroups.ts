export type UsageLimitRow = { id: string; label?: string; percent?: number | null };
export type UsageProviderGroup = { id: string; name?: string; rows: UsageLimitRow[] };
export const useUsageProviderGroups = (): UsageProviderGroup[] => [];
