import Foundation
import GRDB

extension LocalStore {
    public func homeSnapshots() -> AsyncStream<HomeSnapshot> { homeHub.snapshots() }
    /// The home snapshot last handed to its subscribers, read at once; nil
    /// while nothing subscribes.
    public var latestHomeSnapshot: HomeSnapshot? { homeHub.latest }
    public func settingsSnapshots() -> AsyncStream<SettingsSnapshot> { Self.stream(settingsObservation) }
    public func machineSnapshots() -> AsyncStream<MachinesSnapshot> { machinesHub.snapshots() }

    public func stopSnapshotProducers() async {
        await homeHub.stop()
        await machinesHub.stop()
        await troubleshootingHub.stop()
        await draftSessionsHub.stop()
    }

    public func setSessionPresenceOverlay(id: String, value: PresenceOverlayValue) { presenceOverlay.setSession(id, value) }
    public func setMachinePresenceOverlay(id: String, value: PresenceOverlayValue) { presenceOverlay.setMachine(id, value) }

    /// Set before a presence transaction can wake an observation. The raw
    /// DB callback and explicit hub refresh then project the same clock.
    public func setPresenceDisplayClock(_ now: Int64) { presenceOverlay.setClock(now) }

    public func refreshPresenceDisplay() async {
        await homeHub.refresh()
        await machinesHub.refresh()
        await troubleshootingHub.refresh()
    }

    private static func stream<Value: Sendable>(_ observation: SharedValueObservation<Value>) -> AsyncStream<Value> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let cancellable = observation.startWithAsyncCallbacks(onError: { error in
                print("HappyStore snapshot observation stopped: \(error)")
                continuation.finish()
            }, onChange: { value in
                if case .terminated = continuation.yield(value) { return false }
                return true
            })
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    @MainActor
    static func deliverOnMain<Value: Sendable>(_ stream: AsyncStream<Value>,
                                             onChange: @escaping @MainActor (Value) -> Void) -> StoreObservation {
        let task = Task { @MainActor in
            for await value in stream {
                guard !Task.isCancelled else { break }
                onChange(value)
            }
        }
        return StoreObservation(AnyDatabaseCancellable { task.cancel() })
    }
}