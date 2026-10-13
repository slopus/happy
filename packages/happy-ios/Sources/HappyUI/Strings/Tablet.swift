import Foundation

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts,
// and from EmptySessionsTablet.tsx, which writes its English inline.
extension Strings {
    public enum Tablet {
        /// `sidebar.newSession`.
        public static let newSession = "New session"
        /// `zen.toggle`: the zen control's accessibility label.
        public static let zenToggle = "Zen mode"

        // EmptySessionsTablet.tsx.
        public static let noSessionsTitle = "No sessions yet"
        public static func machineUnreachable(name: String) -> String { "\(name) is unreachable" }
        public static let noMachinesReachable = "No machines are reachable"
        public static let onlineDescription = "Start a new session on any of your connected machines."
        public static let startNewSession = "Start New Session"
        public static let offlineDescription = "Bring a machine online to start a session."
        public static let troubleshoot = "Troubleshoot"
        public static let noMachinesDescription = "Install and run Happy on your computer to connect it."

        // The list grouped by project (SessionsList.tsx).
        /// "Bots", hard-coded in SessionsList.tsx as in ProjectHomeList.tsx.
        public static let bots = "Bots"
        /// `status.unknown`: an archived chat with no metadata to name a
        /// place (`getSessionSubtitle`).
        public static let unknown = "unknown"
    }
}
