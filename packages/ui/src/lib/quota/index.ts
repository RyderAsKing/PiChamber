export const QUOTA_PROVIDERS: Array<{ id: string; name: string }> = [];
export const clampPercent = (value: number | null) => value;
export const formatPercent = (value: number | null) => value == null ? "" : String(value);
export const formatQuotaValueLabel = () => "";
export const formatQuotaResetLabel = () => "";
export const resolveUsageTone = (): "safe" | "warn" | "critical" => "safe";
export const formatWindowLabel = (label: string) => label;
export type PaceStatus = "on-track" | "slightly-fast" | "too-fast" | "exhausted";
export interface PaceInfo { status: PaceStatus; expectedPercent: number }
export const calculatePace = (): PaceInfo => ({ status: "on-track", expectedPercent: 0 });
export const getPaceStatusColor = () => "";
export const formatRemainingTime = () => "";
export const calculateExpectedUsagePercent = () => 0;
export * from "./model-families";
