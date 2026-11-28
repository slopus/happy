import Foundation

// The phone's drawer (Steve): Home and Settings are the app's own words;
// the rest is VoiceOver's.
extension Strings {
    enum Drawer {
        static var home: String { localized("common.home", "Home") }
        static var settings: String { Strings.NewSession.settings }
        static let open = "Open menu"
        static let close = "Close menu"
    }
}
