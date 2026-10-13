import Foundation
import HappyCore

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts.
extension Strings {
    public enum Home {
        /// `tabs.sessions`: the phone header's title.
        public static let sessionsTitle = "Sessions"

        /// `status.*`, the socket states HomeHeaderTitle.tsx names.
        public static func connectionStatus(_ status: RealtimeStatus) -> String {
            switch status {
            case .connected: "connected"
            case .connecting: "connecting"
            case .disconnected: "disconnected"
            case .error: "error"
            }
        }

        /// `sessionsFilter.title`: the filter menu's accessibility label.
        public static let filterTitle = "Filter"
        /// `sessionsFilter.appearanceSettings`.
        public static let appearanceSettings = "Appearance Settings"
    }
}
