import Foundation
import HappyCore


extension Strings {
    /// A personal bot's settings on a Happy Cloud server (`BotSettingsViewController`).
    enum Bots {
        static let editTitle = "Bot Settings"
        static let editRow = "Bot Settings"
        static let name = "Name"
        static let instructions = "Instructions"
        static let instructionsPlaceholder = "What this bot does, and how"
        static let changePhoto = "Change Photo"
        static let save = "Save"
        static let tryAgain = "Try Again"
        static let about = "Saved changes reach everyone’s conversation with this bot at its next turn."
        static let loadFailed = "Couldn’t load this bot."
        static let saveFailed = "Couldn’t save. Try again."
        static let notAllowed = "You can’t change this bot."
        static let changedElsewhere = "Someone else changed this bot meanwhile. Check what’s here and save again."
        static func problem(_ problem: BotEdit.Problem) -> String {
            switch problem {
            case .nameMissing: "A bot needs a name."
            case .nameTooLong: "A name is up to \(BotEdit.nameLimit) characters on one line."
            case .instructionsTooLong: "Too long: the server keeps up to \(BotEdit.instructionsLimit / 1024) KB."
            }
        }
        static let discardTitle = "Discard your changes?"
        static let discard = "Discard"
        static let keepEditing = "Keep Editing"
    }
}
