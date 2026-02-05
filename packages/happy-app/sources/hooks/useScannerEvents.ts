import { create } from 'zustand';

interface ScannerEventsState {
    lastScannedCode: string | null;
    scanId: string | null;
    emitScan: (code: string, scanId: string) => void;
    clearScan: () => void;
}

export const useScannerEvents = create<ScannerEventsState>((set) => ({
    lastScannedCode: null,
    scanId: null,
    emitScan: (code, scanId) => set({ lastScannedCode: code, scanId }),
    clearScan: () => set({ lastScannedCode: null, scanId: null }),
}));
