/* eslint-disable */
export const QUOTA_PROVIDERS: Array<{ id: string; name: string }> = [];
export const clampPercent = (value: number | null) => value;
export const formatPercent = (value: number | null) => value == null ? "" : String(value);
export const formatQuotaValueLabel = (_valueLabel?: any, _percent?: any): string => "";
export const formatQuotaResetLabel = (_resetAt?: any, _formatted?: any, _pref?: any): string => "";
export const resolveUsageTone = (): "safe" | "warn" | "critical" => "safe";
export const formatWindowLabel = (label: string) => label;
export type PaceStatus = "on-track" | "slightly-fast" | "too-fast" | "exhausted";
export interface PaceInfo { status: PaceStatus; expectedPercent: number }
export const calculatePace = (): PaceInfo => ({ status: "on-track", expectedPercent: 0 });
export const calculateExpectedUsagePercent = () => 0;
export * from "./model-families";
