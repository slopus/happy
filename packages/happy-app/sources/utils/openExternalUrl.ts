import { Linking, Platform } from 'react-native';
import { isTauri } from './isTauri';

/**
 * Opens a URL in the system browser. Handles Tauri, web, and native platforms.
 */
export async function openExternalUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        if (isTauri()) {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await openUrl(url);
        } else if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
    }

    await Linking.openURL(url);
}
