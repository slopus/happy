import Foundation
import HappyCore

// Stem Cells, spelled as happy-desktop spells them: HappyAgentSpacesSidebar.tsx
// (rows and menus), AppHappyAgentView.tsx (Search, Create) and
// MakeStuffView.tsx (the intro). English only, as desktop is.
extension Strings {
    public enum StemCells {
        /// The home filter's third choice.

        // Rows (HappyAgentSpacesSidebar.tsx, AppHappyAgentView.tsx).
        public static let search = "Search"
        public static let create = "Create"
        /// `happyAgentSpaceLabel`: work is "New" until it has a name.
        public static let untitled = "New"
        public static let untitledSession = "Untitled"
        public static let prioritizing = "Prioritizing"

        // Menus.
        public static let renameTask = "Rename task"
        public static let renameBot = "Rename bot"
        public static let renameSection = "Rename section"
        /// The conversation's name in its bar, for VoiceOver.
        public static let renameHint = "Renames it"
        public static let back = "Back"
        /// A file picked for a message, which carries text and pictures alone.
        public static func filesNotSent(_ names: [String]) -> String {
            names.count == 1 ? "\(names[0]) wasn't attached" : "\(names.count) files weren't attached"
        }
        public static let filesNotSentDetail = "A message to an agent carries text and pictures only for now."
        public static let closeNewWork = "Close new work"
        public static let leaveTask = "Leave task"
        public static let archiveTask = "Archive task"
        public static let archiveBot = "Archive bot"
        public static let archiveSubtask = "Archive subtask"
        public static let deleteSection = "Delete section"
        public static let reorder = "Reorder"

        // A message from another agent (happy-desktop's AgentMessageActivity).
        public static let agentMessage = "Message"
        public static func agentMessageFrom(_ name: String) -> String { "from \(name)" }
        /// An agent this one spawned that has no title yet (`projectSubagents`).
        public static let subagent = "Subagent"
        public static let untitledAgent = "Untitled agent"
        public static let agentMessageOpenHint = "Shows the message"
        public static let agentMessageCloseHint = "Hides the message"
        /// A section's "+", for VoiceOver.
        public static func newWorkIn(_ section: String) -> String { "New work in \(section)" }
        /// Said once a row is lifted from its menu.
        public static let reorderHint = "Lifted. Drag to move it, or tap to put it back."
        /// The blurred screen behind a held row's menu, for VoiceOver.
        public static let closeMenu = "Close menu"
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
        /// Where the viewer is among the conversation's pictures.
        public static func pictureNumber(_ number: Int, of count: Int) -> String { "\(number) of \(count)" }
        /// Desktop's way back to the newest message, and whether the agent
        /// is working as it shows, which UI tests read.
        public static let jumpToLatest = "Jump to latest"
        public static let jumpWorking = "working"
        public static let jumpIdle = "idle"
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
        public static let addProfile = "Add computer"
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
        /// The four permission modes a message runs with (API.md's `permissionMode`).
        public static let permission = "Permission"
        public static func permissionName(_ mode: String) -> String {
            switch mode {
            case "read_only": "Read only"
            case "workspace_write": "Workspace write"
            case "auto": "Auto"
            case "full_access": "Full access"
            default: mode
            }
        }
        public static func permissionDetail(_ mode: String) -> String? {
            switch mode {
            case "read_only": "Reads files; changes nothing."
            case "workspace_write": "Changes files in its workspace only."
            case "auto": "Anything past its workspace is reviewed first."
            case "full_access": "Acts on the whole computer without asking."
            default: nil
            }
        }

        // The composer's "+" sheet, as Claude's "Add to session".
        public static let addToMessage = "Add to message"
        public static let photos = "Photos"
        public static let camera = "Camera"
        public static let cameraUnavailable = "No camera on this device"
        public static let pasteFromClipboard = "Paste from clipboard"
        public static let addFiles = "Add files"
        public static func addPhotos(_ count: Int) -> String { "Add \(count)" }
        public static func photo(picked: Int?) -> String { picked.map { "Photo, picked \($0)" } ?? "Photo" }
        /// The clipboard held nothing a message can carry.
        public static let nothingToPaste = "Nothing to paste"
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
        public static let usageUnknown = "Usage unknown"
        public static let limitReached = "Limit reached"
        public static func usageWindow(_ label: String, left: Int, resets: String?) -> String {
            resets.map { "\(label) · \(left)% left · resets \($0)" } ?? "\(label) · \(left)% left"
        }
        public static func limitResets(_ when: String) -> String { "Limit resets \(when)" }
        public static func serviceAccount(_ service: String, _ account: String) -> String { "\(service) · \(account)" }
        /// Desktop's service header: "Claude (Current CLI)".
        public static func serviceHeader(_ service: String, _ account: String) -> String { "\(service) (\(account))" }
        public static func chipLabel(_ kind: String, _ value: String) -> String { "\(kind): \(value)" }
        /// The lists' names, as desktop labels its panels.
        public static let selectModel = "Select model"
        public static let selectEffort = "Select effort"
        public static func accountsOf(_ service: String) -> String { "\(service) account" }
        /// A service's heading, read aloud: its account and each window it shows.
        public static func headingLabel(_ service: String, _ account: String, _ windows: [String]) -> String {
            (["\(service) account: \(account)"] + windows).joined(separator: ", ")
        }
        /// A gauge: the share left, alone at a row's end or with "left" in the windows.
        public static func usageLeft(_ percent: Int) -> String { "\(percent)%" }
        public static func percentLeft(_ percent: Int) -> String { "\(percent)% left" }
        public static func windowLeft(_ label: String, _ percent: Int) -> String { "\(label) \(percent)% left" }
        public static func resets(_ when: String) -> String { "resets \(when)" }
        public static let updating = "Updating…"
        public static let couldntRefresh = "Couldn’t refresh"
        public static func updated(_ age: String) -> String { "Updated \(age)" }
        public static func updatedFailed(_ when: String) -> String { "Updated \(when) · couldn’t refresh" }
        public static func windowAsOf(_ label: String, _ when: String) -> String { "\(label) as of \(when)" }
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
