import Foundation

/// Something the core did that a part of the app outside it may want to
/// hear of: today only product analytics, which lives in its own target.
/// The core posts and never reads anything back; with no observer, a post
/// does nothing.
public enum Happening: Sendable {
    /// An error the person saw on a message or a conversation.
    public enum ErrorPlace: Sendable {
        case conversationLoad, messageSend, attachmentUpload
    }

    /// How making something ended. A start the person left is not posted.
    public enum Outcome: Sendable {
        case made
        /// The computer said no, in words of its own.
        case refused
        case failed(any Error)
    }

    case errorShown(ErrorPlace, (any Error)?)
    /// A message went into a Happy CLI session's outbox.
    case relayMessageQueued(source: OutgoingMessage.Source, attachments: Int)
    /// New work a first message makes on a Happy Agent.
    case newWorkMade(NewTask.Kind, Outcome)
    /// A start from a composer: a session, a bot or a task.
    case sessionStartEnded(NewSessionLaunch, Outcome)
    /// A paired computer's connection; `problem` is why it last failed.
    case agentConnectionChanged(AgentConnection, problem: (any Error)?)
    case callChanged(from: CallState, to: CallState, at: Double)
}

public enum Happenings {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var observer: (@Sendable (Happening) -> Void)?

    /// The one observer, set once at launch.
    public static func observe(_ next: (@Sendable (Happening) -> Void)?) {
        lock.withLock { observer = next }
    }

    public static func post(_ happening: Happening) {
        lock.withLock { observer }?(happening)
    }
}
