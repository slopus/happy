import Foundation
import GRDB
import XCTest
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyCore

final class SyncPerfMergeTests: XCTestCase {
    func testNoOpSessionMachineProjectProfileAndSettingsWriteNothing() throws {
        let store = try LocalStore.inMemory()
        let session = ChatRecords.storeSession()
        let machine = MachineRecord(id: "m", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                                    metadataVersion: 1, metadataCipher: "c", metadata: .object([:]),
                                    daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
                                    dataKeyCipher: "key", decryptable: true)
        let profile = AccountProfile(id: "account", timestamp: 1)
        let project = ProjectRecord(id: "p", externalId: "external", createdAt: 1, updatedAt: 1,
                                    metadataVersion: 1, metadataCipher: "c", metadata: .object(["name": .string("project")]), dataKeyCipher: "key")
        let settings = AccountSettingsRecord(version: 1, cipher: "c", settings: .object([:]))
        try store.upsertSessions([session])
        try store.replaceMachines([machine])
        try store.applyProfile(profile)
        try store.replaceProjects([project])
        try store.replaceAccountSettings(settings)
        try store.addPendingSettings(["theme": .string("dark")])
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        try store.upsertSessions([session])
        _ = try store.applySessionUpdate(id: "s", metadata: nil, agentState: nil, projectId: nil)
        try store.replaceMachines([machine])
        _ = try store.applyMachineUpdate(id: "m", metadata: nil, daemonState: nil, active: true, activeAt: 1)
        try store.applyProfile(profile)
        try store.replaceProjects([project])
        try store.replaceAccountSettings(settings)
        try store.addPendingSettings(["theme": .string("dark")])
        try store.settlePendingSettings(sent: ["other": .string("unused")])
        try store.setSessionArchiving(id: "s", false)
        XCTAssertEqual(commits.value, 0)
        _ = try store.applySessionUpdate(id: "s", metadata: VersionedPayload(
            version: 2, cipher: "new", value: .object(["title": .string("new")])
        ), agentState: nil, projectId: nil)
        XCTAssertEqual(commits.value, 1)
    }

    func testRepeatedMessagePageAndLiveMessageCommitNothing() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession()])
        let record = ChatRecords.stored(ChatRecords.text("one", at: 1), seq: 1)
        _ = try store.applyLiveMessage(record)
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        _ = try store.applyLiveMessage(record)
        try store.applyMessagePage(sessionId: "s", messages: [record], syncedThrough: 1)
        XCTAssertEqual(commits.value, 0)
        XCTAssertEqual(try store.messages(sessionId: "s").map(\.id), ["one"])
    }

    func testDecodeReuseRequiresSameKeyVersionCipherAndSuccessfulPlaintext() throws {
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let key = Data(repeating: 5, count: 32)
        let wrapped = Base64.encode(try keys.wrapDataKey(key))
        let cipher = RecordCipher(key: key)
        let expected: JSONValue = .object(["title": .string("title")])
        let row = APISession(id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                             metadata: try cipher.encrypt(expected), metadataVersion: 1,
                             agentState: nil, agentStateVersion: 0, dataEncryptionKey: wrapped, projectId: nil)
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        var previous = decoder.session(row)
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, expected)
        // A marker proves the reuse branch ran; it is not a real store fixture.
        previous.metadata = .string("cached")
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, .string("cached"))
        previous.dataKeyCipher = "different key"
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, expected)
        previous = decoder.session(row)
        previous.metadata = nil
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, expected, "retry failed plaintext")
        previous.metadata = .string("cached")
        previous.metadataVersion = 0
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, expected)
        previous.metadataVersion = 1
        previous.metadataCipher = "different cipher"
        XCTAssertEqual(decoder.session(row, previous: previous).metadata, expected)
        XCTAssertNil(decoder.versioned(VersionedValue(version: 1, value: row.metadata), cipher: cipher, after: 1))
    }
}