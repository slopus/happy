import Foundation

// The photo library sheet, as Telegram's attachment gallery says it.
extension Strings {
    public enum Library {
        public static let recents = "Recents"
        public static let cancel = "Cancel"
        public static let limited = "You have limited Happy from accessing all of your photos."
        public static let manage = "Manage"
        public static let selectMore = "Select More Photos"
        public static let changeSettings = "Change Settings"
        public static let denied = "Allow Happy to access your photos to share them."
        public static let openSettings = "Go to Settings"
        public static let empty = "No photos or videos yet"
        public static let couldntRead = "Couldn't read that photo or video"
        public static let done = "Done"
        public static let send = "Send"
        public static let back = "Back"
        /// The picks' count, and the title while the grid shows only them.
        public static func selected(_ count: Int) -> String { "\(count) Selected" }
        public static func add(_ count: Int, action: String) -> String { count > 1 ? "\(action) \(count)" : action }
        public static func photo(_ index: Int?) -> String { index.map { "Photo, picked \($0)" } ?? "Photo" }
        public static func video(_ length: String, index: Int?) -> String { index.map { "Video, \(length), picked \($0)" } ?? "Video, \(length)" }
    }
}
