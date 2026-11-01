import Foundation
import HappyCore

// happy-app has no todo lists, so en.ts has none of these words. They
// follow Happy Desktop's todo Surface (`happy-agent-todo-surface`: its
// field, rows, completed toggle and notices) and stay English in every
// language, as the agent screens' others do.
extension Strings {
    enum Todos {
        // The list of todo lists.
        static let title = "Todos"
        static let newList = "New todo list"
        static let newDocument = "New document"
        static let newListTitle = "New todo list"
        static let newDocumentTitle = "New document"
        static let namePlaceholder = "Name"
        static let create = "Create"
        static let cancel = "Cancel"
        static let new = "New"
        static let lists = "Todo lists"
        static let noLists = "No todo lists yet. Tap + to make one."
        static let loadingLists = "Loading todo lists…"
        static let unsupported = "This Happy Agent doesn’t keep todo lists."
        static func createFailed(_ reason: String) -> String { "It couldn’t be made. \(reason)" }
        static let createFailedTitle = "Not made"
        static let ok = "OK"
        static func outstanding(_ count: Int) -> String { count == 0 ? "Nothing to do" : count == 1 ? "1 to do" : "\(count) to do" }

        // One list.
        static let add = "Add a todo"
        static let empty = "Nothing here yet. What needs doing?"
        static let loading = "Loading todos…"
        static let missing = "This todo list isn’t here. It may belong to a Happy Agent this one can’t reach."
        static func showCompleted(_ count: Int) -> String { "Show \(count) completed" }
        static func hideCompleted(_ count: Int) -> String { "Hide \(count) completed" }
        static let completed = "Completed todos"
        static let more = "More"
        static let showDeleted = "Deleted Todos"
        static let deletedTitle = "Deleted"
        static let deletedEmpty = "No deleted todos."
        static let deletedLoading = "Reading deleted todos…"
        static let restore = "Restore"
        static let delete = "Delete"
        static let history = "History"
        static let undo = "Undo"
        static func deleted(_ text: String) -> String { "Deleted “\(text)”" }
        static func failure(_ reason: String) -> String { "That change couldn’t be saved, so it was undone: \(reason)" }
        static let dismiss = "Dismiss"
        static let todoText = "Todo text"
        static let notSent = "Not sent yet"
        static let moveUp = "Move up"
        static let moveDown = "Move down"
        static let someone = "Someone"

        static func markDone(_ text: String) -> String { "Mark “\(text)” done" }
        static func markNotDone(_ text: String) -> String { "Mark “\(text)” not done" }
        static func deleteLabel(_ text: String) -> String { "Delete “\(text)”" }
        static func deleteHeading(_ text: String) -> String { "Delete heading “\(text)”" }
        static func addedBy(_ name: String) -> String { "Added by \(name)" }
        static let done = "Done"
        static let notDone = "Not done"
        static let heading = "Heading"

        // A todo's history.
        static let historyTitle = "History"
        static let historyEmpty = "No history to show."
        static let historyUnavailable = "The history couldn’t be read. Check that your computer is on."
        static let historyLoading = "Reading the history…"
        static let agent = "An agent"

        /// What a revision did, as its row says it.
        static func change(_ change: TodoRevision.Change) -> String {
            switch change {
            case .created: "Added"
            case .edited(let from): "Changed from “\(from)”"
            case .completed: "Marked done"
            case .reopened: "Marked not done"
            case .deleted: "Deleted"
            case .restored: "Restored"
            case .moved: "Moved"
            case .editedAnd(let state): "Changed and \(Self.change(state).lowercased())"
            }
        }

        // Another kind of Surface, which the phone doesn't open.
        static let openOnComputer = "Open this on your computer to use it."
    }
}
