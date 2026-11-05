import Foundation
import HappyCore

extension Strings {
    /// A computer's Settings › Agents: what a new session starts on, in
    /// desktop's words (General › New sessions), its rows title-cased.
    enum NewSessions {
        static let startOn = "New Sessions Start On"
        static let defaultModel = "Default Model"
        static let defaultEffort = "Default Effort"
        static let defaultAccess = "Default Access Mode"
        static let reading = "Reading…"

        static func start(_ start: ModelPreferences.Start) -> String {
            switch start {
            case .lastSession: "Last Session"
            case .defaultModel: "Default Model"
            }
        }

        static func startFooter(_ start: ModelPreferences.Start) -> String {
            switch start {
            case .lastSession: "The model and effort of the last session you started."
            case .defaultModel: "The model and effort chosen below."
            }
        }

        static func modelFooter(_ start: ModelPreferences.Start) -> String {
            switch start {
            case .lastSession: "Follows the last session you started, on the account you last picked."
            case .defaultModel: "Runs on the account you last picked in a chat."
            }
        }

        static let accessFooter = "What a new session may do without asking. Saved to your account, so they follow you across devices."
    }
}
