import Foundation

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts,
// and from EmptySessionsTablet.tsx, which writes its English inline. A
// `localized` string is keyed by the t() call happy-app makes for it, at
// the cited line; the rest are English in happy-app too.
extension Strings {
    public enum Tablet {
        /// `sidebar.newSession` (SidebarView.tsx 119, ProjectGroup.tsx 131).
        public static var newSession: String { localized("sidebar.newSession", "New session") }
        /// `zen.toggle` (SidebarNavigator.tsx 194): the zen control's
        /// accessibility label.
        public static var zenToggle: String { localized("zen.toggle", "Zen mode") }

        // EmptySessionsTablet.tsx 84-126, in English there.
        public static let noSessionsTitle = "No sessions yet"
        public static func machineUnreachable(name: String) -> String { "\(name) is unreachable" }
        public static let noMachinesReachable = "No machines are reachable"
        public static let onlineDescription = "Start a new session on any of your connected machines."
        public static let startNewSession = "Start New Session"
        public static let offlineDescription = "Bring a machine online to start a session."
        public static let troubleshoot = "Troubleshoot"
        public static let noMachinesDescription = "Install and run Happy on your computer to connect it."

        // The list grouped by project (SessionsList.tsx).
        /// "Bots", in English in SessionsList.tsx 451 as in ProjectHomeList.tsx.
        public static let bots = "Bots"
        /// `status.unknown` (SessionsList.tsx 403): an archived chat with no
        /// metadata to name a place (`getSessionSubtitle`).
        public static var unknown: String { localized("status.unknown", "unknown") }
    }
}
