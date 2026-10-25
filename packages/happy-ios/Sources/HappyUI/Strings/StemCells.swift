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
        /// The conversation's name in its bar, for VoiceOver.
        public static let renameHint = "Renames it"
        public static let closeNewWork = "Close new work"
        public static let leaveTask = "Leave task"
        public static let archiveTask = "Archive task"
        public static let archiveBot = "Archive bot"
        public static let archiveSubtask = "Archive subtask"
        public static let deleteSection = "Delete section"
        public static let tidyNow = "Tidy sidebar now"
        public static let showSubtasks = "Show subtasks"
        public static let hideSubtasks = "Hide subtasks"
        public static let fold = "Collapse"
        public static let unfold = "Expand"
        public static let rename = "Rename"
        // A row pulled open: short names for its two actions.
        public static let swipeClose = "Close"
        public static let swipeLeave = "Leave"
        public static let swipeArchive = "Archive"
        public static let cancel = "Cancel"
        public static let save = "Save"

        // A sidebar Prioritizing proposed (SidebarProposal.tsx, HappyAgentSidebarProposal.tsx).
        public static let proposedSidebar = "Proposed sidebar"
        public static func proposalVersion(_ version: Int) -> String { "v\(version)" }
        public static func proposalLabel(_ version: Int) -> String { "Proposed sidebar, version \(version)" }
        public static let keepMine = "Keep mine"
        public static let useThisSidebar = "Use this sidebar"
        public static let proposalAccepted = "You use this sidebar now."
        public static let proposalDeclined = "You kept your own sidebar."
        public static let proposalLoading = "Loading the proposed sidebar…"
        public static let proposalMissing = "This proposal is no longer available."
        public static let proposalFailed = "That didn't reach your computer. Try again."


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

        // The working line (AgentWorkingStatus.tsx, happyAgentConnection's `activityOf`).
        public static let phaseWaitingForModel = "Waiting for model"
        public static let phaseThinking = "Thinking"
        public static let phasePreparingTools = "Preparing tools"
        public static let phaseRunningTools = "Running tools"
        public static let phaseWorking = "Working"
        public static let phaseDelegating = "Working in subagents"
        public static let phaseAwaitingAnswer = "Waiting for answer"
        public static let phaseWaitEnding = "Wait ending"
        public static func phaseWaitFor(_ remaining: String) -> String { "Wait for \(remaining)" }
        public static let workingSeparator = "·"
        /// conversationFailureText.ts `conversationRetryingLabel`.
        public static func phaseRetrying(kind: String, vendor: String, attempt: Int, of max: Int) -> String {
            let count = "(\(attempt)/\(max))"
            return switch kind {
            case "context_too_long": "Context full — resetting, then retrying…"
            case "provider_unavailable": "\(vendor) is overloaded — retrying \(count)…"
            case "rate_limited": "\(vendor) is rate-limited — retrying \(count)…"
            case "network": "Couldn’t reach \(vendor) — retrying \(count)…"
            default: "\(vendor) — retrying \(count)…"
            }
        }
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
        public static let mediaFailed = "failed"

        // Files and artifacts a tool showed, as desktop's result cards.
        /// What kind of file a presented item is, in a word, from its media type.
        public static func fileKind(kind: String, mimeType: String) -> String {
            if mimeType == "application/pdf" { return "PDF" }
            if kind == "document" { return "Document" }
            let parts = mimeType.split(separator: "/", maxSplits: 1).map(String.init)
            switch parts.first {
            case "image": return "Image"
            case "video": return "Video"
            case "audio": return "Audio"
            case "text" where parts.count > 1: return parts[1] == "plain" ? "Text" : parts[1].uppercased()
            default: return "File"
            }
        }

        /// A byte count in the unit a person reads it in (`artifactSizeText`).
        public static func size(_ bytes: Double) -> String {
            func tenth(_ value: Double) -> String {
                let rounded = (value * 10).rounded() / 10
                return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
            }
            if bytes < 1024 { return "\(Int(bytes)) B" }
            if bytes < 1024 * 1024 { return "\(tenth(bytes / 1024)) KB" }
            if bytes < 1024 * 1024 * 1024 { return "\(tenth(bytes / (1024 * 1024))) MB" }
            return "\(tenth(bytes / (1024 * 1024 * 1024))) GB"
        }

        public static func fileDetail(kind: String, mimeType: String, size: Double?) -> String {
            [fileKind(kind: kind, mimeType: mimeType), size.map { self.size($0) }].compactMap { $0 }.joined(separator: " · ")
        }

        public static func artifactKind(_ type: String) -> String {
            switch type {
            case "markdown": "Markdown"
            case "html": "Web page"
            case "image": "Image"
            case "image_series": "Image series"
            case "video": "Video"
            case "document": "Document"
            default: "Artifact"
            }
        }

        /// A creation's card names its kind; a change's, the version it made.
        public static func artifactDetail(type: String, version: Int) -> String {
            version == 1 ? artifactKind(type) : "\(artifactKind(type)) · Version \(version)"
        }

        public static let untitledArtifact = "Untitled artifact"
        public static func open(_ title: String) -> String { "Open \(title)" }
        public static let artifactDeleted = "This artifact was deleted."
        public static let artifactUnavailable = "This artifact couldn’t be loaded. Check that your computer is on."
        public static let artifactLive = "This page runs on your computer. Open it there."
        public static let fileUnavailable = "This file couldn’t be loaded. Check that your computer is on."

        // Settings, from the computer's picture.
        public static let accounts = "Accounts"
        public static let happySettings = "Happy settings"
        public static let openSettings = "Settings"
        public static let edit = "Edit"
        public static let done = "Done"
        public static let searchSettings = "Search settings"
        public static let showQR = "QR code"
        public static let addProfile = "Add a computer or account"
        public static let more = "More"
        public static let status = "Status"
        public static let account = "Account"
        public static let appearance = "Appearance"
        public static let language = "Language"
        public static let disconnect = "Disconnect"
        public static let signOut = "Sign out"
        public static let addHappyAccount = "Add Happy account"
        public static let directComputer = "Direct computer"
        public static let happyAccount = "Happy account"
        public static let disconnectTitle = "Disconnect computer?"
        public static let signOutTitle = "Sign out?"
        public static let removeDetail = "This removes the connection and its credentials from this phone."
        public static let couldNotRename = "Could not rename"
        public static let couldNotSwitch = "Could not switch"
        public static let couldNotRemove = "Could not remove"
        public static let nothingFound = "Nothing found"
        // The QR sheet: nothing is shared, so Scan comes first.
        public static let qrCode = "QR Code"
        public static let qrText = "Scan a computer’s pairing code, or a code from the terminal or another device."
        public static let scanQRCode = "Scan QR Code"
        public static let enterLink = "Enter link manually"
        public static let signInFirst = "Sign in to Happy"
        public static let signInFirstDetail = "Sign in to a Happy account before connecting this kind of code."

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
