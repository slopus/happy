#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Light and dark, the way happy-app applies `themePreference`: unistyles.ts
/// on launch and settings/appearance.tsx when the row changes it both call
/// `Appearance.setColorScheme`, which on iOS sets every window's
/// `overrideUserInterfaceStyle`, and paint the root view `groupped.background`.
///
/// Every `ColorToken` reaches UIKit as a dynamic `UIColor(token)`, and the
/// few colours that are baked into a layer re-resolve on
/// `UITraitUserInterfaceStyle` changes, so the window's style is all there
/// is to switch.
///
/// The preference is per account (`LocalSettings`), so it is always read
/// from `context.account.localSettings` at the moment it is applied, never
/// kept. `AppCoordinator` applies it on launch and on every account change.
@MainActor
public enum ThemeController {
    /// The UIKit style for a preference: adaptive follows the system.
    public static func style(for preference: ThemePreference) -> UIUserInterfaceStyle {
        switch preference {
        case .adaptive: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    /// Pins `window` to `preference`, or lets it follow the system, and
    /// gives it RN's root view background.
    public static func apply(_ preference: ThemePreference, to window: UIWindow) {
        window.overrideUserInterfaceStyle = style(for: preference)
        window.backgroundColor = UIColor(Palette.groupedBackground)
    }

    /// The active account's stored preference, applied to `window`. For
    /// launch and account switches.
    public static func apply(from context: AppContext, to window: UIWindow) {
        apply(context.account.localSettings.themePreference, to: window)
    }

    /// What appearance.tsx's Theme row does: stores `preference` for the
    /// active account and applies it to every window at once.
    public static func set(_ preference: ThemePreference, in context: AppContext) {
        context.account.localSettings.themePreference = preference
        let stored = context.account.localSettings.themePreference
        for window in allWindows {
            // UIKit's own windows (the keyboard's, text effects) take the
            // style, never the ground: they lie over the app's, and once
            // the keyboard has shown, a ground there covers the whole screen.
            if type(of: window) == UIWindow.self {
                apply(stored, to: window)
            } else {
                window.overrideUserInterfaceStyle = style(for: stored)
            }
        }
    }

    private static var allWindows: [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
    }
}
#endif
