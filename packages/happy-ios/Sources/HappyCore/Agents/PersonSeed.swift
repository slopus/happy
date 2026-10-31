import Foundation

/// What a person's placeholder picture is picked by (`AvatarPlaceholder`),
/// wherever they are drawn without a picture: the Profile page and its
/// Settings row, the tasks they made and those tasks' profiles. In a team
/// it is their team user ID, the same on every phone and the one other
/// members' tasks draw them with; outside a team, the seed their account
/// had (`otherwise`).
///
/// A computer's own picture is not a person's: Settings' header, its
/// accounts card and the account switcher keep the computer's seed
/// (`AgentConnections.placeholderSeed(for:)`).
public enum PersonSeed {
    public static func seed(userId: String?, otherwise: String) -> String {
        guard let userId, !userId.isEmpty else { return otherwise }
        return userId
    }
}
