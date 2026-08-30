import './sources/polyfills/screenOrientation';
import { isPublicSessionShareBrowserPath } from './sources/utils/publicSessionShareRouting';

// The public viewer must not evaluate authenticated MMKV-backed theme state.
if (isPublicSessionShareBrowserPath()) {
    require('./sources/publicUnistyles');
} else {
    require('./sources/unistyles');
}
require('expo-router/entry');
