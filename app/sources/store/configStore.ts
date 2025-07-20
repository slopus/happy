import { create } from "zustand";

interface ConfigState {
  showDebugInfo: boolean;
  toggleDebugInfo: () => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  showDebugInfo: false,
  toggleDebugInfo: () => set((state) => ({ showDebugInfo: !state.showDebugInfo })),
})); 