import Foundation
import GRDB

extension LocalStore {
    public func homeSnapshots() -> AsyncStream<HomeSnapshot> { Self.stream(homeObservation) }
    public func settingsSnapshots() -> AsyncStream<SettingsSnapshot> { Self.stream(settingsObservation) }
    public func machineSnapshots() -> AsyncStream<MachinesSnapshot> { Self.stream(machinesObservation) }

    private static func stream<Value: Sendable>(_ observation: SharedValueObservation<Value>) -> AsyncStream<Value> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let cancellable = observation.start(onError: { _ in continuation.finish() }, onChange: { value in
                continuation.yield(value)
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