#if canImport(UIKit)
import HappyCore
import UIKit

/// What the settings pages hand to other parts of the app. Each is set once
/// at launch by the part that owns it; until then Settings still saves the
/// choice and the page works, it just has nothing to call.
@MainActor
public enum SettingsHooks {
    /// The active account's push registration, for Settings › Account's
    /// push rows. HappyApp's `PushNotifications` replaces it on every
    /// account change; nil while signed out.
    public static var pushRegistration: (any PushRegistration)?
}
#endif
