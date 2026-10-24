import Foundation
import HappyCore

// Stem Cells, spelled as happy-desktop spells them: HappyAgentSpacesSidebar.tsx
// (rows and menus), AppHappyAgentView.tsx (Search, Create) and
// MakeStuffView.tsx (the intro). English only, as desktop is.
extension Strings {
    public enum StemCells {
        /// The home filter's third choice.
        public static let filterTitle = "Stem Cells"

        // Rows (HappyAgentSpacesSidebar.tsx, AppHappyAgentView.tsx).
        public static let search = "Search"
        public static let create = "Create"
        /// `happyAgentSpaceLabel`: work is "New" until it has a name.
        public static let untitled = "New"
        public static let untitledSession = "Untitled"
        public static let prioritizing = "Prioritizing"

        // Menus.
        public static let open = "Open"
        public static let openBot = "Open bot"
        public static let renameTask = "Rename task"
        public static let renameBot = "Rename bot"
        public static let renameSection = "Rename section"
        public static let closeNewWork = "Close new work"
        public static let leaveTask = "Leave task"
        public static let archiveTask = "Archive task"
        public static let archiveBot = "Archive bot"
        public static let tidyNow = "Tidy sidebar now"
        public static let showSubtasks = "Show subtasks"
        public static let hideSubtasks = "Hide subtasks"
        public static let fold = "Collapse"
        public static let unfold = "Expand"
        public static let rename = "Rename"
        public static let cancel = "Cancel"
        public static let save = "Save"

        // Prioritizing's setting, which only the person turns on.
        public static let prioritizingOff = "Prioritizing is off"
        public static let prioritizingOffDetail = "Turn it on to name and place new work."
        public static let turnOn = "Turn on"

        // States.
        public static let noComputer = "Pair a computer to see its Stem Cells."
        public static let pairComputer = "Pair a computer"
        public static let unsupported = "This computer's Happy Agent is too old for Stem Cells. Update it, then come back."
        public static let connecting = "Connecting…"
        public static let offline = "Offline — showing what this phone last saw."
        public static let unanswered = "The computer did not answer."
        public static func newWorkFailed(_ reason: String) -> String { "New work could not be made. \(reason)" }

        // New work (MakeStuffView.tsx).
        public static let introLine = "Say what it is — it’ll find its place."
        public static let introOptions = "Or start one of these:"
        public static let composerPlaceholder = "Describe it…"
        public static let working = "Working…"
        public static let sending = "Sending…"
        public static let sendFailed = "Not sent. Tap to retry."
    }
}
