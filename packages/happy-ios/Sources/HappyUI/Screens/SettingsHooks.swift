#if canImport(UIKit)
import HappyCore
import UIKit

/// What the settings pages hand to other parts of the app. Each is set once
/// at launch by the part that owns it; until then Settings still saves the
/// choice and the page works, it just has nothing to call.
@MainActor
public enum SettingsHooks {
    /// This device's push registration, for Settings › Account's push rows.
    /// TODO(ops): set once push notifications land; nil means this device
    /// has no token of its own yet.
    public static var pushRegistration: (any PushRegistration)?
}
#endif
