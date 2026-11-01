import Foundation
import HappyWire

/// What one open document hears from the account's event stream.
public enum DocumentStreamEvent: Equatable, Sendable {
    /// A stream is up under this name: subscribe to it, then catch up.
    case connected(streamId: String)
    /// The stream went away; its subscriptions with it.
    case disconnected
    case update(DocumentUpdateFrame)
    case presence(DocumentPresenceFrame)
}

/// Routes the event stream's live document frames to the documents open on
/// this account. `SyncEngine` owns the one stream and says when it opens,
/// what its `hello` named it, and when it closes; frames never touch the
/// journal or the catalog.
public actor DocumentStreams {
    private var streamId: String?
    private var listeners: [UUID: (surfaceId: String, continuation: AsyncStream<DocumentStreamEvent>.Continuation)] = [:]

    public init() {}

    /// The stream's current name, if one is up.
    public var current: String? { streamId }

    /// Events for one document, starting with `connected` when a stream is already up.
    public func events(_ surfaceId: String) -> AsyncStream<DocumentStreamEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: DocumentStreamEvent.self)
        listeners[id] = (surfaceId, continuation)
        if let streamId { continuation.yield(.connected(streamId: streamId)) }
        continuation.onTermination = { [weak self] _ in Task { await self?.remove(id) } }
        return stream
    }

    private func remove(_ id: UUID) { listeners[id] = nil }

    /// The `hello` frame. Daemons without collaborative documents name no stream.
    public func opened(_ hello: JSONValue) {
        guard let id = hello["streamId"]?.stringValue else { return }
        streamId = id
        for listener in listeners.values { listener.continuation.yield(.connected(streamId: id)) }
    }

    public func closed() {
        guard streamId != nil else { return }
        streamId = nil
        for listener in listeners.values { listener.continuation.yield(.disconnected) }
    }

    /// Whether `event` is a live document frame, routed here, rather than a journal event.
    public static func isDocumentFrame(_ event: String) -> Bool {
        event == "document.update" || event == "document.presence"
    }

    public func frame(_ event: String, data: String) {
        let decoded: DocumentStreamEvent
        let surfaceId: String
        if event == "document.update", let frame = try? JSONDecoder().decode(DocumentUpdateFrame.self, from: Data(data.utf8)) {
            decoded = .update(frame); surfaceId = frame.surfaceId
        } else if event == "document.presence", let frame = try? JSONDecoder().decode(DocumentPresenceFrame.self, from: Data(data.utf8)) {
            decoded = .presence(frame); surfaceId = frame.surfaceId
        } else {
            return
        }
        for listener in listeners.values where listener.surfaceId == surfaceId { listener.continuation.yield(decoded) }
    }

    public func stop() {
        streamId = nil
        for listener in listeners.values { listener.continuation.finish() }
        listeners.removeAll()
    }
}
