import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class SendingAttachmentPlanTests: XCTestCase, @unchecked Sendable {
    func testPurePlanFiltersFlavorAndRigPolicyWithoutEnqueuing() throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(
            fixture.session("s", updatedAt: 1)
        )
        let image = attachment("image", mimeType: "image/png", size: 10)
        let oversized = attachment("large", mimeType: "image/jpeg", size: 101)
        let document = attachment("doc", mimeType: "application/pdf", size: 10)
        session.metadata = .object([
            "client": .object(["id": .string("rig")]),
            "rigMetadataVersion": .number(1),
            "capabilities": .object([
                "attachments": .object([
                    "enabled": .bool(true),
                    "maxBytes": .number(100),
                    "mediaTypes": .array([.string("image/*")]),
                ]),
            ]),
        ])
        let rigPlan = OutboxSender.attachmentPlan(
            OutgoingMessage(text: "", attachments: [image, oversized, document]), session: session
        )
        XCTAssertEqual(rigPlan.accepted, [image])
        XCTAssertEqual(rigPlan.rejected, [oversized, document])
        XCTAssertTrue(rigPlan.shouldShowUnsupportedAlert)
        XCTAssertTrue(rigPlan.shouldSendText)
        session.metadata = .object(["flavor": .string("gemini")])
        let unsupportedPlan = OutboxSender.attachmentPlan(
            OutgoingMessage(text: " ", attachments: [image]), session: session
        )
        XCTAssertTrue(unsupportedPlan.accepted.isEmpty)
        XCTAssertEqual(unsupportedPlan.rejected, [image])
        XCTAssertTrue(unsupportedPlan.shouldShowUnsupportedAlert)
        XCTAssertFalse(unsupportedPlan.shouldSendText)
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
    }

    func testAcceptDefensivelyDropsRejectedFilesAndRefusesAttachmentOnlyMessage() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(
            fixture.session("s", updatedAt: 1)
        )
        session.metadata = .object(["flavor": .string("gemini")])
        try store.upsertSessions([session])
        let engine = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: fixture.keys)
        await engine.setBackgrounded(true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory)
        // An unreadable rejected file must not even be copied.
        let rejected = attachment("missing", mimeType: "image/png", size: 10)
        let message = OutgoingMessage(text: "text remains", attachments: [rejected])
        let plan = try sender.attachmentPlan(message, sessionId: "s")
        XCTAssertEqual(plan.rejected, [rejected])
        XCTAssertTrue(try store.pendingOutbox().isEmpty)
        let localId = try await sender.send(message, sessionId: "s")
        let items = try store.pendingOutbox()
        XCTAssertEqual(items.map(\.localId), [localId])
        XCTAssertEqual(items.map(\.kind), [.message])
        XCTAssertNil(items[0].dependsOn)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
        do {
            _ = try await sender.send(OutgoingMessage(text: " ", attachments: [rejected]), sessionId: "s")
            XCTFail("expected unsupportedAttachments")
        } catch {
            XCTAssertEqual(error as? SendingError, .unsupportedAttachments)
        }
        XCTAssertEqual(try store.pendingOutbox().count, 1)
        await engine.stop()
    }

    func testAcceptKeepsOnlyFilesAllowedByRigPolicy() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(
            fixture.session("s", updatedAt: 1)
        )
        session.metadata = .object([
            "client": .object(["id": .string("rig")]),
            "rigMetadataVersion": .number(1),
            "capabilities": .object([
                "attachments": .object([
                    "enabled": .bool(true), "maxBytes": .number(100),
                    "mediaTypes": .array([.string("image/*")]),
                ]),
            ]),
        ])
        try store.upsertSessions([session])
        let engine = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: fixture.keys)
        await engine.setBackgrounded(true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let pickedURL = directory.appendingPathComponent("picked")
        try Data([1, 2, 3]).write(to: pickedURL)
        let accepted = OutgoingAttachment(fileURL: pickedURL, name: "accepted", mimeType: "image/png", size: 3)
        let rejected = attachment("rejected", mimeType: "application/pdf", size: 3)
        let sender = OutboxSender(store: store, sync: engine, filesDirectory: directory.appendingPathComponent("files"))
        let localId = try await sender.send(
            OutgoingMessage(text: "", attachments: [accepted, rejected]), sessionId: "s"
        )
        let items = try store.pendingOutbox()
        XCTAssertEqual(items.map(\.kind), [.file, .message])
        XCTAssertEqual(items[1].localId, localId)
        XCTAssertEqual(items[1].dependsOn, items[0].localId)
        XCTAssertEqual(try store.attachment(outboxLocalId: items[0].localId)?.name, "accepted")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: sender.filesDirectory.path).count, 1)
        await engine.stop()
    }

    private func attachment(_ name: String, mimeType: String, size: Int) -> OutgoingAttachment {
        OutgoingAttachment(
            fileURL: URL(fileURLWithPath: "/missing/\(name)"),
            name: name,
            mimeType: mimeType,
            size: size
        )
    }
}
