import './sources/polyfills/screenOrientation';
import { bootstrapStorage } from './sources/persistence/bootstrapStorage';
import { isPublicSessionShareBrowserPath } from './sources/utils/publicSessionShareRouting';

// The public viewer must not evaluate authenticated MMKV-backed theme state.
if (isPublicSessionShareBrowserPath()) {
    require('./sources/publicUnistyles');
    require('expo-router/entry');
} else {
    bootstrapStorage(() => {
        require('./sources/unistyles');
        require('expo-router/entry');
    });
}
