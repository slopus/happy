import * as Clipboard from 'expo-clipboard';

export async function getClipboardStringTrimmedSafe(): Promise<string> {
    try {
        return (await Clipboard.getStringAsync()).trim();
    } catch {
        return '';
    }
}

