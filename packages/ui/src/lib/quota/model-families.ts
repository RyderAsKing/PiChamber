/* eslint-disable */
export const getAllModelFamilies = (_providerId?: string): Array<{ id: string; label: string }> => [];
export const getDisplayModelName = (id?: string) => id ?? '';
export const groupModelsByFamily = (_models?: any, _providerId?: string) => new Map<string | null, string[]>();
export const sortModelFamilies = <T,>(families: T[]): T[] => families;
