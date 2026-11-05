import Foundation
import HappyCore

extension Strings {
    /// Settings › New Sessions: what a new session starts on, in desktop's
    /// words (General › New sessions).
    enum NewSessions {
        static let title = "New Sessions"
        static let startOn = "Start On"
        static let defaultModel = "Default Model"
        static let defaultEffort = "Default Effort"
        static let reading = "Reading…"

        static func start(_ start: ModelPreferences.Start) -> String {
            switch start {
            case .lastSession: "Last Session"
            case .defaultModel: "Default Model"
            }
        }

        static func footer(_ start: ModelPreferences.Start) -> String {
            let what = switch start {
            case .lastSession: "New sessions start on the model and effort of the last session you started, on the account you last picked."
            case .defaultModel: "New sessions start on the model and effort chosen here, on the account you last picked."
            }
            return what + " Saved to your account, so they follow you across devices."
        }
    }
}
