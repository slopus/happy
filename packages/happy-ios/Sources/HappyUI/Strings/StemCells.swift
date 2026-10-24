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

        // What new work offers to make at once (AppHappyAgentView.tsx `SURFACE_CREATE_OFFERS`).
        public static func offer(_ offer: StemCellOffer) -> String {
            switch offer {
            case .bot: "New bot"
            case .surface("todo"): "New todo list"
            case .surface("document"): "New document"
            case .surface("calendar"): "New calendar"
            case .surface("system_monitor"): "New system monitor"
            case .surface("chat"): "New chat"
            case .surface: "New"
            }
        }
        /// The name a new Surface starts with, which the person may change first.
        public static func surfaceName(_ type: String) -> String {
            switch type {
            case "todo": "Todo list"
            case "document": "Document"
            case "calendar": "Calendar"
            case "system_monitor": "System Monitor"
            case "chat": "Chat"
            default: "Untitled"
            }
        }
        public static let nameIt = "Name it"
        public static let make = "Create"
        public static let newBot = "New Bot"

        // A Surface on the phone: read, and a todo added.
        public static let addTodo = "Add a todo"
        public static let noTodos = "Nothing here yet."
        public static let todoDone = "done"
        public static let emptyDocument = "This document is empty."
        public static let openOnComputer = "Open this on your computer to use it."

        // Pictures and recordings in a conversation.
        public static let picture = "Picture"
        public static let video = "Video"
        public static let playVideo = "Play video"
        public static func media(isVideo: Bool, name: String) -> String { "\(isVideo ? video : picture): \(name)" }
        public static let addPicture = "Add a picture"
        public static let close = "Close"
        /// A tile's accessibility value, which UI tests wait on.
        public static let mediaLoading = "loading"
        public static let mediaLoaded = "loaded"

        // Settings, from the Happy mark.
        public static let thisComputer = "This computer"
        public static let accounts = "Accounts"
        public static let accountsDetail = "Switch account, pair a computer or add a Happy account"
        public static let happySettings = "Happy settings"
        public static let openSettings = "Settings"

        // The composer's pickers (desktop's ComposerModelControl, flattened).
        public static let model = "Model"
        public static let provider = "Provider"
        public static let effort = "Effort"
        public static let modelsNotConfigured = "Models not configured"
        public static let latestBenchmarks = "Latest benchmarks"
        public static let hiddenAccount = "Hidden account. It still works; it’s only kept out of the lists."
        public static func accountRemoved(_ name: String) -> String { "The \(name) account is no longer configured on this Happy Agent." }
        public static func accountOff(_ name: String) -> String { "The \(name) account is switched off, so nothing is sent to it." }
        public static func window(_ kind: StemCellAccountUsage.Window.Kind) -> String {
            switch kind {
            case .week: "Week"
            case .session: "Session"
            }
        }
        public static func percentLeft(_ percent: Int) -> String { "\(percent)% left" }
        public static let usageUnknown = "Usage unknown"
        public static let updating = "Updating…"
        public static let couldntRefresh = "Couldn’t refresh"
        public static let limitReached = "Limit reached"
        public static func usageLeft(_ percent: Int) -> String { "\(percent)%" }
        public static func usageWindow(_ label: String, left: Int, resets: String?) -> String {
            resets.map { "\(label) · \(left)% left · resets \($0)" } ?? "\(label) · \(left)% left"
        }
        public static func limitResets(_ when: String) -> String { "Limit resets \(when)" }
        public static func updated(_ age: String) -> String { "Updated \(age)" }
        public static func updatedFailed(_ when: String) -> String { "Updated \(when) · couldn’t refresh" }
        public static func windowAsOf(_ label: String, _ when: String) -> String { "\(label) as of \(when)" }
        public static func serviceAccount(_ service: String, _ account: String) -> String { "\(service) · \(account)" }
        /// Desktop's service header: "Claude (Current CLI)".
        public static func serviceHeader(_ service: String, _ account: String) -> String { "\(service) (\(account))" }
        public static func chipLabel(_ kind: String, _ value: String) -> String { "\(kind): \(value)" }

        /// `usageAge`: how long ago, in a word.
        public static func age(_ date: Date, now: Date) -> String {
            let minutes = Int(now.timeIntervalSince(date) / 60)
            if minutes < 1 { return "just now" }
            if minutes < 60 { return "\(minutes) min ago" }
            let hours = minutes / 60
            if hours < 20 { return "\(hours) hr ago" }
            return "at \(clock(date, now: now))"
        }

        /// `clockTime`: the time, with its weekday when it isn't within the day.
        public static func clock(_ date: Date, now: Date) -> String {
            let time = date.formatted(date: .omitted, time: .shortened)
            return abs(now.timeIntervalSince(date)) < 20 * 3600 ? time : "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
        }

        /// `localDayTime`: today's time alone; any other day leads with its weekday.
        public static func dayTime(_ date: Date, now: Date) -> String {
            let time = date.formatted(date: .omitted, time: .shortened)
            return Calendar.current.isDate(date, inSameDayAs: now) ? time : "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
        }
    }
}
