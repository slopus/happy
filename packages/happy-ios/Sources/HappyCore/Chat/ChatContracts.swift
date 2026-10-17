import Foundation
import HappyWire

// The seams between the chat's parts, so each side can be built and tested
// on its own:
//
//     LocalStore (messages + outbox) ──▶ ChatFeed (reducer) ──▶ chat UI
//     chat UI ──▶ ChatSending ──▶ outbox ──▶ server
//     chat UI ──▶ SessionActions (permission, abort, questions) ──▶ RPC
//
// The UI never touches records or the wire; the reducer and the sender never
// touch UIKit.

/// Where an unsent message is on its way out. Nil on a `ChatMessage` the
/// server already has.
public enum OutboxDelivery: Equatable, Sendable {
    /// Stored, waiting for the network or for an earlier item.
    case queued
    /// Being uploaded or posted right now.
    case sending
    /// Gave up after retrying; the person can retry or discard it.
    case failed(String)
}

/// The latest model usage drives the composer's context meter.
public struct ChatUsage: Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheCreation: Int
    public var cacheRead: Int
    public var contextSize: Int
    public var contextWindow: Int?

    public init(inputTokens: Int, outputTokens: Int, cacheCreation: Int, cacheRead: Int, contextSize: Int, contextWindow: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreation = cacheCreation
        self.cacheRead = cacheRead
        self.contextSize = contextSize
        self.contextWindow = contextWindow
    }
}

/// A session's chat as the UI shows it, oldest first, ordered by
/// `ChatMessage.sortKey`. Unsent messages from the outbox are included as
/// pending user messages; `delivery` says where each one is.
public struct ChatSnapshot: Equatable, Sendable {
    public var sessionId: String
    public var messages: [ChatMessage]
    /// Outbox state by `localId`, for messages the server doesn't have yet.
    public var delivery: [String: OutboxDelivery]
    /// False until messages have been pulled or the server confirms the
    /// session is empty (seq == 0), so chat can distinguish loading from empty.
    public var isLoaded: Bool
    public var usage: ChatUsage?
    public var todos: JSONValue?
    /// Durable paging facts read in the same transaction as the message rows.
    public var hasMoreOlder: Bool
    public var olderBoundary: Int?
    /// Changes only when a covered window discards previously included rows.
    public var windowEpoch: Int

    public init(sessionId: String, messages: [ChatMessage] = [], delivery: [String: OutboxDelivery] = [:], isLoaded: Bool = false, usage: ChatUsage? = nil, todos: JSONValue? = nil, hasMoreOlder: Bool = false, olderBoundary: Int? = nil, windowEpoch: Int = 0) {
        self.sessionId = sessionId
        self.messages = messages
        self.delivery = delivery
        self.isLoaded = isLoaded
        self.usage = usage
        self.todos = todos
        self.hasMoreOlder = hasMoreOlder
        self.olderBoundary = olderBoundary
        self.windowEpoch = windowEpoch
    }
}

/// A session's chat, kept current from the local store. The first snapshot
/// comes straight from disk, before any network.
public protocol ChatFeed: Sendable {
    func snapshots(sessionId: String) -> AsyncStream<ChatSnapshot>
}

/// A picture or file picked to send. The sender owns `fileURL` from the
/// moment it is handed over: it is a copy in the account's files directory,
/// so the send survives a relaunch.
public struct OutgoingAttachment: Equatable, Sendable {
    public var fileURL: URL
    public var name: String
    public var mimeType: String
    public var size: Int
    public var width: Int?
    public var height: Int?
    public var thumbhash: String?

    public init(fileURL: URL, name: String, mimeType: String, size: Int, width: Int? = nil, height: Int? = nil, thumbhash: String? = nil) {
        self.fileURL = fileURL
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.thumbhash = thumbhash
    }
}

/// What the composer hands over (sync.ts `sendMessage` and its options).
public struct OutgoingMessage: Equatable, Sendable {
    public enum Source: String, Sendable {
        case chat
        case voice
        case newSession = "new_session"
    }

    public var text: String
    /// Shown in the chat instead of `text`.
    public var displayText: String?
    public var attachments: [OutgoingAttachment]
    public var source: Source

    public init(text: String, displayText: String? = nil, attachments: [OutgoingAttachment] = [], source: Source = .chat) {
        self.text = text
        self.displayText = displayText
        self.attachments = attachments
        self.source = source
    }
}

/// Sends through the outbox: the message is stored first and appears in the
/// chat at once; delivery happens whenever the network allows.
public protocol ChatSending: Sendable {
    /// Returns the message's `localId`.
    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String
    func retry(localId: String) async throws
    /// Drops an unsent message and anything queued behind it for it.
    func discard(localId: String) async throws
}
