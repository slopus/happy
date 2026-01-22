export function requireReactNativeScreens(): any {
    // IMPORTANT:
    // Use `require` so this module can be imported in cross-platform code without pulling
    // react-native-screens into non-native bundles. Callers should only invoke this on native.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-screens');
}

