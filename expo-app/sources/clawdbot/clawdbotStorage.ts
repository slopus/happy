import { MMKV } from 'react-native-mmkv';
import type { ClawdbotGatewayConfig } from './clawdbotTypes';

const STORAGE_KEY = 'clawdbot-gateway-config';
const mmkv = new MMKV();

/**
 * Load saved gateway configuration from storage
 */
export function loadClawdbotConfig(): ClawdbotGatewayConfig | null {
    const raw = mmkv.getString(STORAGE_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as ClawdbotGatewayConfig;
    } catch {
        return null;
    }
}

/**
 * Save gateway configuration to storage
 */
export function saveClawdbotConfig(config: ClawdbotGatewayConfig): void {
    mmkv.set(STORAGE_KEY, JSON.stringify(config));
}

/**
 * Clear gateway configuration from storage
 */
export function clearClawdbotConfig(): void {
    mmkv.delete(STORAGE_KEY);
}

/**
 * Check if a gateway config is saved
 */
export function hasClawdbotConfig(): boolean {
    return mmkv.contains(STORAGE_KEY);
}
