import Foundation
import HappyWire

/// Something the core did that a part of the app outside it may want to
/// hear of: today only product analytics, which lives in its own target.
/// The core posts and never reads anything back; with no observer, a post
/// does nothing. Each carries closed words and counts only: never an error,
/// a launch, a connection or anything else the core holds.
public enum Happening: Sendable, Equatable {
    /// An error the person saw on a message or a conversation.
    public enum ErrorPlace: Sendable, Equatable {
        case conversationLoad, messageSend, attachmentUpload
    }

    /// How making something ended. A start the person left is not posted.
    public enum Outcome: Sendable, Equatable {
        case made
        /// The computer said no, in words of its own.
        case refused
        case failed(Problem)

        /// A failure, by its error's type alone.
        public static func failure(_ error: Error) -> Outcome { .failed(Problem(error) ?? .unknown) }
    }

    /// A composer's start, as much of it as says what was started.
    public struct Start: Sendable, Equatable {
        public enum Made: Sendable, Equatable { case session, bot, task }
        public var made: Made
        public var agent: NewSessionDraft.Agent
        /// The model as the composer named it; nil for the harness's default.
        public var model: String?
        public var effort: String?

        public init(made: Made, agent: NewSessionDraft.Agent, model: String? = nil, effort: String? = nil) {
            self.made = made; self.agent = agent; self.model = model; self.effort = effort
        }

        public init(_ launch: NewSessionLaunch) {
            let made: Made = switch launch.target {
            case .bot?: .bot
            case .task?: .task
            default: launch.bot != nil ? .bot : .session
            }
            self.init(made: made, agent: launch.agent, model: launch.modelMode == "default" ? nil : launch.modelMode,
                      effort: launch.effortLevel)
        }
    }

    case errorShown(ErrorPlace, Problem)
    /// A message went into a Happy CLI session's outbox.
    case relayMessageQueued(source: OutgoingMessage.Source, attachments: Int)
    /// New work a first message makes on a Happy Agent; `agentId` is its
    /// conversation as the phone named it (`NewTask.agentId`).
    case newWorkMade(NewTask.Kind, agentId: String, Outcome)
    /// A start from a composer: a session, a bot or a task.
    case sessionStartEnded(Start, Outcome)
    /// A paired computer's connection, by its id (never sent): down while
    /// it retries or is revoked, with why it last failed; `direct` with no
    /// server between.
    case agentConnectionChanged(id: String, direct: Bool, down: Bool, problem: Problem?)
    case callChanged(from: CallState, to: CallState, at: Double)
}

/// Why something failed, by its error's type and status alone, never its
/// words. Nil for a cancellation, which nobody saw as a failure.
public enum Problem: Sendable, Equatable {
    case offline
    /// The host couldn't be found or reached.
    case unreachable
    /// Some other failure on the way.
    case network
    case timeout
    case unauthorized
    case revoked
    case versionMismatch
    case invalidResponse
    case status(Int)
    case unknown

    public init?(_ error: Error) {
        switch error {
        case is CancellationError: return nil
        case let error as URLError:
            switch error.code {
            case .cancelled: return nil
            case .timedOut: self = .timeout
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: self = .offline
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed: self = .unreachable
            default: self = .network
            }
        case let error as APIError:
            self = switch error {
            case .unauthenticated, .unauthorized: .unauthorized
            case .http(let status, _): .status(status)
            case .decoding: .invalidResponse
            }
        case let error as AgentClientError:
            self = switch error {
            case .status(let status, _, _): .status(status)
            case .revoked: .revoked
            case .invalidResponse: .invalidResponse
            }
        case let error as PairingError:
            self = switch error {
            case .unavailable: .offline
            case .updateRequired: .versionMismatch
            case .revoked: .revoked
            case .invalidResponse: .invalidResponse
            default: .unknown
            }
        case is POSIXError: self = .offline
        default: self = .unknown
        }
    }
}

public enum Happenings {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var observer: (@Sendable (Happening) -> Void)?

    /// The one observer, set while analytics may listen.
    public static func observe(_ next: (@Sendable (Happening) -> Void)?) {
        lock.withLock { observer = next }
    }

    public static func post(_ happening: Happening) {
        lock.withLock { observer }?(happening)
    }

    /// An error the person saw; nil is one with no error behind it. A
    /// cancellation is not posted.
    public static func errorShown(_ place: Happening.ErrorPlace, _ error: (any Error)?) {
        let problem: Problem? = if let error { Problem(error) } else { .unknown }
        if let problem { post(.errorShown(place, problem)) }
    }
}
