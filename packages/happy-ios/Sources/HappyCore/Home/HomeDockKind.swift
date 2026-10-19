import Foundation

/// What the home composer makes: a session, a bot or a task. The dock's
/// segmented control offers the ones the chosen computer's Happy Agent can
/// make (HomeDock.tsx's Session | Bot, and a task as Happy Desktop makes
/// one), and shows none when it can make only sessions.
public enum HomeDockKind: Equatable, Sendable {
    case session
    case bot
    case task

    /// The segments, in order.
    public static func offered(supportsBots: Bool, supportsTasks: Bool) -> [HomeDockKind] {
        [.session] + (supportsBots ? [.bot] : []) + (supportsTasks ? [.task] : [])
    }

    /// The draft's kind; it never makes both.
    public static func current(createsBot: Bool, createsTask: Bool) -> HomeDockKind {
        createsBot ? .bot : createsTask ? .task : .session
    }
}
