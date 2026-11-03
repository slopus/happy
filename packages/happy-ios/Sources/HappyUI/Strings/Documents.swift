import Foundation

// A document Surface, as desktop's DocumentSurface and DocumentEditor say it.
extension Strings {
    public enum Documents {
        public static let untitled = "Untitled"
        public static let saved = "Saved"
        public static let saving = "Saving…"
        /// Kept on the phone while the computer can't be reached.
        public static let waiting = "Waiting to sync"
        public static let loading = "Loading…"
        public static let unavailable = "This document couldn't be opened."
        public static let markdownOnly = "Editing this document needs a newer Happy on the computer."
        public static let gone = "This document is gone."
        public static let refused = "The computer didn't take a change, so this document was read again."
        public static let more = "More"
        public static let rename = "Rename"
        public static let renameTitle = "Rename Document"
        public static let renamePlaceholder = "Name"
        public static let history = "History"
        public static let cancel = "Cancel"
        public static let save = "Save"
        public static let done = "Done"
        public static let leave = "Remove from Sidebar"
        public static func leaveTitle(_ name: String) -> String { "Remove “\(name)”?" }
        public static let leaveMessage = "It leaves your sidebar. Everyone else keeps it, and you can join it again from Tabs."
        public static let leaveConfirm = "Remove"

        // The formatting bar and its menus.
        public static let text = "Text"
        public static let lineBreak = "Line Break"
        public static func heading(_ level: Int) -> String { "Heading \(level)" }
        public static let headings = "Text Style"
        public static let bold = "Bold"
        public static let italic = "Italic"
        public static let strike = "Strikethrough"
        public static let code = "Code"
        public static let link = "Link"
        public static let bullets = "Bulleted List"
        public static let numbers = "Numbered List"
        public static let checklist = "Checklist"
        public static let quote = "Quote"
        public static let codeBlock = "Code Block"
        public static let indent = "Indent"
        public static let outdent = "Outdent"
        public static let divider = "Divider"
        public static let hideKeyboard = "Hide Keyboard"
        public static let linkTitle = "Link"
        public static let linkPlaceholder = "https://"
        public static let removeLink = "Remove Link"

        // What VoiceOver says of a line beyond its text.
        public static let task = "Task"
        public static let taskDone = "Done"
        public static let notDone = "Not done"
        public static let toggleTask = "Toggle task"
        public static let dividerLine = "Divider"
        public static let picture = "Picture"
        public static let table = "Table"
        public static let unsupported = "Something Happy can't show here"
        public static func editing(_ names: [String]) -> String {
            switch names.count {
            case 0: ""
            case 1: "\(names[0]) is here"
            default: "\(names.dropLast().joined(separator: ", ")) and \(names.last!) are here"
            }
        }

        // History.
        public static let historyTitle = "History"
        public static let historyEmpty = "No changes yet"
        public static let someone = "Someone"
        public static let agent = "An agent"
        public static let conversion = "Made from Markdown"
        public static func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
        public static func version(_ seq: Int) -> String { "Version \(seq)" }
        public static let current = "Current version"
    }
}
