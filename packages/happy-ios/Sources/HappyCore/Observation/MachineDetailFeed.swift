import Foundation
import HappyStore

/// The account's machine screens have their own SQL region and lifetime.
/// Recent-session ordering follows updatedAt without waking Home.
public final class MachineDetailFeed: Sendable {
    private let store: LocalStore
    private let scope = AccountFeedScope()

    public init(store: LocalStore) { self.store = store }

    public func snapshots(machineId: String) -> AsyncStream<MachineScreenContent> {
        scope.snapshots { [store] in
            AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
                let task = Task.detached {
                    var last: MachineScreenContent?
                    for await snapshot in store.machineDetailSnapshots(machineId: machineId) {
                        guard !Task.isCancelled else { break }
                        ThreadRules.assertOffMain()
                        let content = MachineScreenContent(snapshot)
                        guard content != last else { continue }
                        last = content
                        continuation.yield(content)
                    }
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
    }

    func stop() { scope.stop() }
}