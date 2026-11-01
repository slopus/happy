import Foundation

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts.
// A `localized` string is keyed by the t() call happy-app makes for it, at
// the cited line; the rest are this app's own.
extension Strings {
    public enum Tablet {
        /// `sidebar.newSession` (SidebarView.tsx 119, ProjectGroup.tsx 131).
        public static var newSession: String { localized("sidebar.newSession", "New session") }

        /// The main panel with nothing open beside the sidebar. This app's
        /// own: happy-app's tablet shows home's empty index route there.
        public static let nothingOpen = "Choose a chat in the sidebar."
        /// The sidebar's button, as iPadOS names it.
        public static let hideSidebar = "Hide Sidebar"
        public static let showSidebar = "Show Sidebar"
    }
}
