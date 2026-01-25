import * as Localization from 'expo-localization';
import type { DeviceLocale } from './deviceLocales';

export function getDeviceLocales(): readonly DeviceLocale[] {
    return Localization.getLocales() as readonly DeviceLocale[];
}

