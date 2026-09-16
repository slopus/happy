export function shouldShowFirstRunInstall({
    isAuthenticated,
    isDataReady,
    machineCount,
    isWeb,
    isRunningOnMac,
}: {
    isAuthenticated: boolean;
    isDataReady: boolean;
    machineCount: number;
    isWeb: boolean;
    isRunningOnMac: boolean;
}): boolean {
    return isAuthenticated
        && isDataReady
        && machineCount === 0
        && !isWeb
        && !isRunningOnMac;
}

export function shouldSuppressTabletShell({
    isAuthenticated,
    isTablet,
    showInstallStep,
    isOnboardingRoute,
    isWeb,
    isRunningOnMac,
}: {
    isAuthenticated: boolean;
    isTablet: boolean;
    showInstallStep: boolean;
    isOnboardingRoute: boolean;
    isWeb: boolean;
    isRunningOnMac: boolean;
}): boolean {
    return isAuthenticated
        && isTablet
        && !isWeb
        && !isRunningOnMac
        && (showInstallStep || isOnboardingRoute);
}