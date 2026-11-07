import Foundation
import HappyCore

// A vault Surface's words. Like the todo, document and artifact screens
// they follow Happy Desktop and stay English in every language.
extension Strings {
    enum Vaults {
        /// A listed vault the person's role may not open.
        static let locked = "You don’t have access to this vault."
        static let title = "Vault"

        // The browser.
        static let loading = "Loading…"
        static let empty = "This folder is empty. Tap + to add files."
        static let emptyInTrash = "This folder is empty."
        static let missing = "This folder isn’t here. It may have been removed, or belong to a Happy Agent this one can’t reach."
        static let inTrash = "This folder is in the Trash. Restore it to change what is inside."
        static let uploads = "Uploading"
        static let add = "Add"
        static let more = "More"
        static let newFolder = "New Folder"
        static let uploadFiles = "Upload Files"
        static let uploadPhotos = "Upload Photos and Videos"
        static let sortBy = "Sort By"
        static let sortName = "Name"
        static let sortDate = "Date Modified"
        static let sortSize = "Size"
        static let ascending = "Ascending"
        static let descending = "Descending"
        static let trash = "Trash"
        static let settings = "Vault Settings"
        static let downloadFolder = "Download Folder as Zip"
        static let downloadVault = "Download Vault as Zip"
        static let app = "App"
        static let folder = "Folder"

        // Actions.
        static let open = "Open"
        static let rename = "Rename"
        static let move = "Move"
        static let share = "Share"
        static let downloadZip = "Download as Zip"
        static let history = "Version History"
        static let uploadNewVersion = "Upload New Version"
        static let delete = "Move to Trash"
        static let restore = "Restore"
        static let restoreTo = "Restore To…"
        static let cancel = "Cancel"
        static let create = "Create"
        static let save = "Save"
        static let retry = "Try Again"
        static let cancelUpload = "Cancel Upload"
        static let namePlaceholder = "Name"
        static let renameTitle = "Rename"
        static let newFolderTitle = "New Folder"
        static let untitledFolder = "untitled folder"
        static let failedTitle = "That didn’t work"
        static func nameTaken(_ name: String) -> String { "There’s already an item named “\(name)” here. Choose another name." }
        static let artifactSuffixRefused = "Names ending in .artifact are kept for apps. Choose another name."
        static let invalidName = "A name can’t contain / or \\, or be . or .."
        static let changedElsewhere = "Someone changed this at the same time. Try again."
        static let gone = "This item isn’t in the vault anymore."
        static let inTrashRefused = "Items in the Trash can’t be changed. Restore it first."
        static let tooLarge = "It’s larger than the vault takes."
        static let nameTakenShort = "Something here already has that name."
        static let invalidUpload = "The computer couldn’t use this file."
        static let offline = "The computer can’t be reached. Try again when it’s back."
        static func replaceTitle(_ name: String) -> String { "“\(name)” already exists" }
        static let replaceMessage = "Replacing it keeps the current file as an earlier version, so you can go back to it."
        static let replace = "Replace"
        static let keepBoth = "Keep Both"
        static func sending(_ percent: Int) -> String { "Uploading · \(percent)%" }
        static let placing = "Finishing…"
        static func uploadFailed(_ reason: String) -> String { "Upload failed: \(reason)" }
        static let downloading = "Downloading…"
        static func items(_ count: Int) -> String { count == 1 ? "1 item" : "\(count) items" }

        // Move.
        static func moveTitle(_ name: String) -> String { "Move “\(name)”" }
        static let moveHere = "Move Here"
        static let restoreHere = "Restore Here"
        static let noFolders = "No folders here."
        static let cantMoveHere = "A folder can’t go inside itself."

        // Trash.
        static let trashTitle = "Trash"
        static let trashEmpty = "The Trash is empty."
        static let trashLoading = "Reading the Trash…"
        static func trashKept(_ days: Int?) -> String {
            guard let days else { return "Items stay in the Trash until they are restored." }
            return days == 1 ? "Items in the Trash are removed after a day." : "Items in the Trash are removed after \(days) days."
        }
        static func deletedFrom(_ path: String, _ when: String) -> String { "\(when) · from \(path)" }

        // History.
        static let historyTitle = "Version History"
        static let historyLoading = "Reading the history…"
        static let historyUnavailable = "The history couldn’t be read."
        static let versions = "Versions"
        static let activity = "Activity"
        static func version(_ number: Int) -> String { "Version \(number)" }
        static let current = "Current"
        static let pinned = "Pinned"
        static let pin = "Pin"
        static let unpin = "Unpin"
        static let preview = "Preview"
        static let restoreVersion = "Restore This Version"
        static func restoredFrom(_ number: Int) -> String { "restored from version \(number)" }
        static func restoreConfirm(_ number: Int) -> String { "Version \(number) becomes the newest version. Nothing is lost: the current one stays in the history." }
        static let pinnedNote = "Pinned versions are always kept."
        static let agent = "An agent"
        static let someone = "Someone"
        static func created(_ name: String) -> String { "Created “\(name)”" }
        static func renamed(_ from: String, _ to: String) -> String { "Renamed from “\(from)” to “\(to)”" }
        static let moved = "Moved"
        static let deleted = "Moved to the Trash"
        static let restored = "Restored from the Trash"
        static func versionMade(_ number: Int) -> String { "Made version \(number)" }
        static func versionRestored(_ number: Int, _ from: Int) -> String { "Made version \(number) from version \(from)" }
        static func pinnedVersion(_ number: Int) -> String { "Pinned version \(number)" }
        static func unpinnedVersion(_ number: Int) -> String { "Unpinned version \(number)" }
        static let changed = "Changed"

        // Settings.
        static let settingsTitle = "Vault Settings"
        static let keepVersions = "Keep Versions"
        static let presetTimeMachine = "Time Machine"
        static let presetDefault = "Default"
        static let presetTimeMachineDetail = "Every version for a day, then daily for a month, then weekly"
        static let presetKeepEverything = "Keep everything"
        static let presetKeepEverythingDetail = "Never remove old versions"
        static let presetLastTen = "Last 10 versions"
        static let presetLastTenDetail = "Keep the 10 newest versions of each file"
        static let presetCustom = "Custom"
        static let presetCustomDetail = "Your own rules, below"
        static let rules = "Custom Rules"
        static let keepAllFor = "Keep every version for"
        static let thinAfter = "Then keep one version"
        static func tier(_ after: Int, _ every: Int) -> String { "After \(days(after)), one every \(days(every))" }
        static let addTier = "Add a Rule"
        static let removeTier = "Remove"
        static let maxVersions = "At most"
        static let maxAge = "Remove versions older than"
        static let noLimit = "No limit"
        static func versionsCount(_ count: Int) -> String { count == 1 ? "1 version" : "\(count) versions" }
        static let trashDuration = "Keep Items in the Trash"
        static let forever = "Until restored"
        static func days(_ count: Int) -> String {
            switch count {
            case 0: "0 days"
            case 1: "1 day"
            case 7: "1 week"
            case 365: "1 year"
            default: "\(count) days"
            }
        }
        static let afterDaysTitle = "After how many days?"
        static let everyDaysTitle = "Keep one version every how many days?"
        static let numberPlaceholder = "Number"
        static let selected = "Selected"
        static let settingsLoading = "Reading the settings…"
        static let saveFailed = "The settings couldn’t be saved."
    }
}
