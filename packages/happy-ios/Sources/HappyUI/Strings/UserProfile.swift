import Foundation
import HappyCore

// A team member's profile on a Happy Cloud server, and the people search
// finds there. English only, as the rest of V2 is.
extension Strings {
    public enum UserProfile {
        public static let people = "People"
        public static let tasks = "Tasks"
        public static let activeTasks = "Active tasks"
        public static let activeDays = "Active days"
        public static let lastActive = "Last active"
        public static let tokens = "Tokens"
        public static let lastActivity = "Last activity"
        public static let untitledTask = "Untitled task"
        public static let leftTeam = "Left the team"
        public static let notAllowed = "Your role can't see profiles"
        public static let notFound = "Not on your team"
        public static let failed = "Couldn't load this profile"

        /// "14 of 30".
        public static func activeDays(_ days: Int) -> String { "\(days) of 30" }

        /// The window a token total counts over.
        public static func window(_ window: AgentWire.UsageWindow) -> String {
            switch window {
            case .hour: "Past hour"
            case .day: "Past day"
            case .week: "Past week"
            case .month: "Past month"
            }
        }

        /// Their role on the team: a built-in one by name, a team's own by its ID.
        public static func teamRole(_ role: String?) -> String {
            switch role {
            case nil: leftTeam
            case "owner": "Owner"
            case "admin": "Admin"
            case "member": "Member"
            case "viewer": "Viewer"
            case let other?: other
            }
        }

        /// "2 hours ago", "Just now".
        public static func ago(_ age: DetailFormat.Age) -> String {
            age == .justNow ? Strings.age(age) : "\(Strings.age(age)) ago"
        }
    }
}
