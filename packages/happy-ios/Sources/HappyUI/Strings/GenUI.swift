import Foundation
import HappyCore

extension Strings {
    /// What VoiceOver says of a Gen UI's controls beyond their labels. Not
    /// in happy-app's catalogs: every language's are in
    /// `TranslationCatalog.nativeSources` (`genUISources`).
    enum GenUI {
        /// A choice that was made.
        static var selected: String { localized("native.genui.selected", "Selected") }
        /// A button whose action can't run where it is shown.
        static var unavailable: String { localized("native.genui.unavailable", "Unavailable here") }
        /// A secret action whose form saved.
        static var saved: String { localized("native.genui.saved", "Saved") }
    }
}

extension Strings {
    /// The Happy Agent secret form a Gen UI `secret` action opens
    /// (`GenUISecretFormViewController`). English until it is translated.
    enum GenUISecret {
        static let newTitle = "New Secret"
        static let changeTitle = "Change Secret"
        static let name = "Name"
        static let namePlaceholder = "stripe"
        static let nameProblem = "2–32 characters: a lowercase letter, then lowercase letters, digits, _ or -."
        static let checking = "Checking for a secret with this name…"
        static let changes = "A secret with this name exists. Saving changes it; a value left empty keeps what is stored."
        static let managed = "This secret is managed by Happy Agent and can’t be changed here."
        static let description = "Description"
        static let descriptionPlaceholder = "What these values are for"
        static let descriptionProblem = "Say what the secret is for, in at most 2,000 characters."
        static let variables = "Variables"
        static let variableName = "Variable name"
        static let variablePlaceholder = "API_KEY"
        static let value = "Value"
        static let valuePlaceholder = "Value"
        static let keepPlaceholder = "Keep the stored value"
        static let valueMissing = "Needs a value"
        static let remove = "Remove Variable"
        static func removeNamed(_ name: String) -> String { name.isEmpty ? remove : "Remove \(name)" }
        static let add = "Add Variable"
        static let noVariables = "Add at least one variable."
        static let variableNameProblem = "Variable names are letters, digits and _, not starting with a digit."
        static let variableTwice = "Each variable needs its own name."
        static let valueProblem = "Type a value for every variable."
        static let about = "Values go straight to your computer and are never shown to the agent. It is told the secret’s name and its variables."
        static func added(_ id: String) -> String { "Added \(id)" }
        static func updated(_ id: String) -> String { "Updated \(id)" }
        static func told(_ names: [String]) -> String {
            "The agent can now use \(names.joined(separator: ", ")). It was told in its conversation; the values stay on your computer."
        }
        static let failedTitle = "Couldn’t Save"
        static let stale = "The secret changed since this form opened. It shows the secret as it is now; check it and save again."
        static let exists = "A secret with this name already exists. The form now changes it; check it and save again."
        static let conflict = "The computer can’t save this here. The agent that asked may be gone, or the secret is managed elsewhere."
        static let refused = "The computer refused this form. Check the name, description and variables."
        static let unavailable = "This computer can’t save secrets from here."
        static let failed = "Couldn’t reach the computer. Your values are still in the form; try again."
    }
}
