/**
 * Native UIGlassEffect interaction is intentionally disabled. JS gesture
 * handlers provide press feedback and action dispatch without allowing the
 * native glass view to compete for responder ownership.
 */
export function getNativeGlassInteractivity(_interactive: boolean): false {
    return false;
}

/** Expo owns menu presentation on native iOS; Mac, web, and Android keep their platform routes. */
export function shouldUseExpoNativeSettingsMenu(platform: string, runningOnMac: boolean): boolean {
    return platform === 'ios' && !runningOnMac;
}
