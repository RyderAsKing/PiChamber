import { create } from 'zustand';

/** Synthetic Settings-only item; it is never sent as a Pi provider identity. */
export const PI_CUSTOM_PROVIDER_SELECTION = '__pi_custom_provider__';

interface PiProviderSelectionState {
  selectedProviderId: string | null;
  setSelectedProviderId: (providerId: string | null) => void;
}

/** Settings-only selection state. Provider catalog/auth remain server-authoritative. */
export const usePiProviderSelectionStore = create<PiProviderSelectionState>((set) => ({
  selectedProviderId: null,
  setSelectedProviderId: (selectedProviderId) => set((current) => current.selectedProviderId === selectedProviderId ? current : { selectedProviderId }),
}));
