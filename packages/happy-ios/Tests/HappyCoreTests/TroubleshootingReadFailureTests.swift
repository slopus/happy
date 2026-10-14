import Foundation
import GRDB
import XCTest
import HappyWire
@testable import HappyStore
@testable import HappyCore

private final class TroubleProjectionFault: @unchecked Sendable {
    enum Shape: Sendable { case healthy, sqlNull, object, shortArray }
    private let lock = NSLock()
    private var shape: Shape = .healthy
    var value: Shape {
        get { lock.withLock { shape } }
        set { lock.withLock { shape = newValue } }
    }
}

final class TroubleshootingReadFailureTests: XCTestCase {
    @MainActor
    func testInvalidProjectionEndsStreamRetainsVisibleContentAndRecovers() async throws {
        for shape in [TroubleProjectionFault.Shape.sqlNull, .object, .shortArray] {
            let fault = TroubleProjectionFault()
            var configuration = Configuration()
            // Override only json_extract's four-path overload. The normal
            // machine projection and membership predicates use other arities.
            configuration.prepareDatabase { db in
                db.add(function: DatabaseFunction("json_extract", argumentCount: 5) { arguments in
                    switch fault.value {
                    case .sqlNull: return nil
                    case .object: return "{}"
                    case .shortArray: return "[]"
                    case .healthy:
                        guard let text = String.fromDatabaseValue(arguments[0]) else { return nil }
                        let document = try JSONValue.decode(Data(text.utf8))
                        let fields: [JSONValue] = [document["machineId"] ?? .null,
                                                  document["project"]?["name"] ?? .null,
                                                  document["path"] ?? .null,
                                                  document["happyHomeDir"] ?? .null]
                        return String(decoding: try JSONValue.array(fields).encoded(), as: UTF8.self)
                    }
                })
            }
            let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
            try store.replaceMachines([ApplyPerfFixtures.machine])
            try store.upsertSessions([ApplyPerfFixtures.session(0)])
            let feed = TroubleshootingFeed(store: store)
            let recorder = ApplyPerfRecorder<TroubleshootState>()
            let screen = VisibleFeed<TroubleshootState> { recorder.take($0) }
            screen.start { feed.snapshots() }
            await applyPerfWait { recorder.outputs.count == 1 }
            let cached = try XCTUnwrap(recorder.outputs.last)
            XCTAssertTrue(cached.aiPrompt.contains("project"))
            // Observe termination directly, rather than inferring a failure
            // from the absence of another screen publication.
            let raw = store.troubleshootingSnapshots()
            _ = try await syncPerfNext(raw)
            fault.value = shape
            let threw = await Task.detached {
                do {
                    try store.writer.read { db in _ = try LocalStore.fetchTroubleshootingSnapshot(db) }
                    return false
                } catch { return true }
            }.value
            XCTAssertTrue(threw, "SQL NULL, wrong JSON shape and short arrays throw instead of trapping")
            var record = ApplyPerfFixtures.session(0)
            var metadata = record.metadata?.objectValue ?? [:]
            metadata["path"] = .string("/work/recovered")
            record.metadata = .object(metadata)
            record.metadataVersion += 1
            record.updatedAt += 1
            try store.upsertSessions([record])
            let ended = try await syncPerfNext(raw)
            XCTAssertNil(ended, "the tracking error finishes the observed stream")
            screen.stop()
            await feed.stop()
            XCTAssertEqual(recorder.outputs, [cached], "a failed read preserves the last applied screen content")
            fault.value = .healthy
            let fresh = TroubleshootingFeed(store: store)
            screen.start { fresh.snapshots() }
            await applyPerfWait { recorder.outputs.count == 2 }
            XCTAssertTrue(recorder.outputs.last?.aiPrompt.contains("recovered") == true)
            screen.stop()
            await fresh.stop()
            await store.stopSnapshotProducers()
        }
    }
}