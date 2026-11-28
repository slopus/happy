import Foundation
import HappyCore

// Someone's profile on a Happy Cloud server, and the people search finds
// there. English only, as the rest of V2 is.
extension Strings {
    public enum UserProfile {
        public static let people = "People"
        public static let tasks = "Tasks"
        public static let activeTasks = "Active tasks"
        public static let activeDays = "Active days"
        public static let lastActive = "Last active"
        public static let tokens = "Tokens"
        public static let teams = "Teams"
        public static let owner = "Owner"
        public static let member = "Member"
        public static let lastActivity = "Last activity"
        public static let untitledTask = "Untitled task"
        public static let leftServer = "Left the server"
        public static let notAllowed = "You can't see profiles here"
        public static let notFound = "Not on this server"
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

        /// Whether they are an owner of the server: `owner`, their flag
        /// from `GET /v0/members`, else the profile's `teamRole`, which is
        /// nil once they left.
        public static func standing(owner: Bool?, teamRole: String?) -> String {
            if let owner { return owner ? Self.owner : member }
            guard let teamRole else { return leftServer }
            return teamRole == "owner" ? Self.owner : member
        }

        /// "2 hours ago", "Just now".
        public static func ago(_ age: DetailFormat.Age) -> String {
            age == .justNow ? Strings.age(age) : "\(Strings.age(age)) ago"
        }
    }
}
