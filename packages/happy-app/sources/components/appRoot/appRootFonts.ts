import * as Fonts from 'expo-font';
import { Fredoka_600SemiBold, Fredoka_700Bold } from '@expo-google-fonts/fredoka';
import {
    Feather,
    FontAwesome,
    FontAwesome5,
    Ionicons,
    MaterialCommunityIcons,
    MaterialIcons,
    Octicons,
} from '@expo/vector-icons';
import { Platform } from 'react-native';
import { AsyncLock } from '@/utils/lock';

const lock = new AsyncLock();
let loaded = false;
const vectorIconFonts = {
    ...Feather.font,
    ...FontAwesome.font,
    ...FontAwesome5.font,
    ...Ionicons.font,
    ...MaterialCommunityIcons.font,
    ...MaterialIcons.font,
    ...Octicons.font,
};

export async function loadAppRootFonts(): Promise<void> {
    await lock.inLock(async () => {
        if (loaded) return;
        loaded = true;
        const isTauri = Platform.OS === 'web'
            && typeof window !== 'undefined'
            && (window as any).__TAURI_INTERNALS__ !== undefined;
        const fonts = {
            SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),
            'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
            'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
            'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),
            'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
            'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
            'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),
            'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),
            'Fredoka-SemiBold': Fredoka_600SemiBold,
            'Fredoka-Bold': Fredoka_700Bold,
            ...vectorIconFonts,
        };

        if (!isTauri) {
            await Fonts.loadAsync(fonts);
            return;
        }
        void Fonts.loadAsync(fonts).catch(() => undefined);
    });
}
