#if canImport(UIKit)
import HappyCore
import UIKit

/// What the settings pages hand to other parts of the app. Each is set once
/// at launch by the part that owns it; until then Settings still saves the
/// choice and the page works, it just has nothing to call.
@MainActor
public enum SettingsHooks {
    /// Applies Settings › Appearance › Theme to the app's windows (unistyles
    /// plus `Appearance.setColorScheme` in happy-app). Called after the
    /// preference is saved in `LocalSettings.themePreference`.
    /// TODO(icons): set by the Icons workstream's theme application.
    public static var applyTheme: ((ThemePreference) -> Void)?

    /// This device's push registration, for Settings › Account's push rows.
    /// TODO(ops): set once push notifications land; nil means this device
    /// has no token of its own yet.
    public static var pushRegistration: (any PushRegistration)?
}
#endif
