import Foundation
import GRDB
import HappyWire

/// What a session's own screens (info.tsx) read of the store: the session,
/// its computer, the settings, whether sessions were ever fetched, and the
/// composer's picks. Presence reads as home shows it.
public struct SessionDetailSnapshot: Equatable, Sendable {
    public var session: SessionRecord?
    /// The session's computer, when it names one that is stored.
    public var machine: MachineRecord?
    public var settings: SettingsSnapshot
    /// happy-app's `isDataReady`: the session list was fetched at least
    /// once, or something is stored.
    public var dataReady: Bool
    /// The composer's stored picks for the session.
    public var composer: JSONValue

    public init(session: SessionRecord?, machine: MachineRecord?, settings: SettingsSnapshot, dataReady: Bool, composer: JSONValue) {
        self.session = session
        self.machine = machine
        self.settings = settings
        self.dataReady = dataReady
        self.composer = composer
    }
}

extension LocalStore {
    private static let detailQueue = DispatchQueue(label: "HappyStore.sessionDetail", qos: .userInitiated)

    /// The snapshot now, read off the main thread.
    public func sessionDetail(sessionId: String) throws -> SessionDetailSnapshot {
        let overlay = presenceOverlay
        return try performRead { db in Self.project(try Self.fetchSessionDetail(db, sessionId: sessionId), overlay) }
    }

    /// The snapshot now, then each distinct one, fetched and compared on a
    /// background queue. Only this session's row, its computer, the
    /// settings, the list cursor and its composer are read. Fields no
    /// session screen shows are left out of what is compared (`shown`), so
    /// a send accepted here wakes nothing; `sessionDetail` keeps them.
    public func sessionDetailSnapshots(
        sessionId: String,
        onError: @escaping @Sendable (SessionDetailFailure) -> Void = { _ in }
    ) -> AsyncStream<SessionDetailSnapshot> {
        let writer = self.writer
        let overlay = presenceOverlay
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let last = DetailLast()
            let cancellable = ValueObservation
                .tracking { db in
                    ThreadRules.assertOffMain()
                    return try Self.fetchSessionDetail(db, sessionId: sessionId)
                }
                .removeDuplicates()
                .start(
                    in: writer,
                    scheduling: .async(onQueue: Self.detailQueue),
                    onError: { error in
                        onError(SessionDetailFailure(error))
                        continuation.finish()
                    },
                    onChange: { raw in
                        // A presence checkpoint moves stored stamps the
                        // screen never shows; it yields nothing.
                        let value = Self.shown(Self.project(raw, overlay))
                        guard last.replace(value) else { return }
                        continuation.yield(value)
                    }
                )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    static func fetchSessionDetail(_ db: Database, sessionId: String) throws -> SessionDetailSnapshot {
        let session = try SessionRecord.fetchOne(db, key: sessionId)
        let machine = try session?.metadata?["machineId"]?.stringValue.flatMap { try MachineRecord.fetchOne(db, key: $0) }
        var dataReady = try SyncStateRecord.exists(db, key: SyncCursor.sessionsChangedSince.rawValue)
        if !dataReady, session == nil {
            dataReady = try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM session)") ?? false
        } else if session != nil {
            dataReady = true
        }
        return SessionDetailSnapshot(
            session: session,
            machine: machine,
            settings: try fetchSettingsSnapshot(db),
            dataReady: dataReady,
            composer: try ComposerStateRecord.fetchOne(db, key: sessionId)?.values ?? .object([:])
        )
    }

    /// Without the local activity stamp of the last send accepted here
    /// (`enqueueAcceptedSend`): it orders home's list, and no session screen
    /// shows it. `updatedAt` and `seq` stay; info.tsx shows them.
    static func shown(_ value: SessionDetailSnapshot) -> SessionDetailSnapshot {
        var value = value
        value.session?.lastMessageSentAt = nil
        return value
    }

    private static func project(_ raw: SessionDetailSnapshot, _ overlay: PresenceOverlay) -> SessionDetailSnapshot {
        var value = raw
        value.session = raw.session.map(overlay.session)
        value.machine = raw.machine.map(overlay.machine)
        return value
    }
}

/// The last value a detail stream yielded; touched only on its serial
/// delivery queue.
private final class DetailLast: @unchecked Sendable {
    private var value: SessionDetailSnapshot?

    /// Keeps `next` and says whether it differs from the last one.
    func replace(_ next: SessionDetailSnapshot) -> Bool {
        guard next != value else { return false }
        value = next
        return true
    }
}
