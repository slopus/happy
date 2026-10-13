import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class SendingCompatibilityTests: XCTestCase {
    func testAdditionalMetaKeysSurviveWireEncodingAfterKnownFields() throws {
        let payload: JSONValue = .object([
            "role": .string("user"),
            "meta": .object([
                "sentFrom": .string("ios"),
                "zExtra": .bool(true),
                "aExtra": .null,
                "quote\"Extra": .string("value"),
            ]),
        ])
        let bytes = try UserMessageEncoder.wireBytes(payload)
        XCTAssertEqual(try JSONValue.decode(bytes), payload)
        XCTAssertEqual(
            String(decoding: bytes, as: UTF8.self),
            #"{"role":"user","meta":{"sentFrom":"ios","aExtra":null,"quote\"Extra":"value","zExtra":true}}"#
        )
    }

    func testHappyAppFileEventsByteForByte() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "file-events", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONValue.decode(Data(contentsOf: url)).arrayValue)
        for test in cases {
            let attachment = AttachmentRecord(
                localId: "local", sessionId: "s", path: "local", name: test["name"]!.stringValue!,
                mimeType: "", size: Int(test["size"]!.numberValue!), width: Int(test["width"]!.numberValue!),
                height: Int(test["height"]!.numberValue!), thumbhash: test["thumbhash"]?.stringValue, createdAt: 123
            )
            let result = SyncEngine.filePayload(id: "event-id", time: 123, attachment: attachment, ref: "blob-ref")
            XCTAssertEqual(try result.encoded(), Data(test["canonical"]!.stringValue!.utf8))
            XCTAssertEqual(try UserMessageEncoder.wireBytes(result), Data(test["wire"]!.stringValue!.utf8))
        }
    }

    func testActualHappyAppMetadataAndWireBytes() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sending", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONValue.decode(Data(contentsOf: url)).arrayValue)
        for test in cases {
            var session = SessionRecord(
                id: "s", seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0, projectId: nil,
                metadataVersion: 1, metadataCipher: "", metadata: test["metadata"], agentStateVersion: 1,
                agentStateCipher: nil, agentState: test["agentState"], dataKeyCipher: nil, decryptable: true
            )
            session.thinking = test["thinking"]?.boolValue ?? false
            let message = OutgoingMessage(text: test["text"]!.stringValue!, displayText: test["displayText"]?.stringValue, source: test["source"]?.stringValue == "new_session" ? .newSession : .chat)
            do {
                let result = try UserMessageEncoder.encode(
                    message, session: session, composer: test["composer"]!, settings: test["settings"],
                    hasPendingUserMessage: test["pending"]?.boolValue ?? false,
                    sentFrom: test["sentFrom"]?.stringValue ?? "ios"
                )
                XCTAssertNil(test["error"], test["name"]!.stringValue!)
                XCTAssertEqual(try result.encoded(), Data(test["canonical"]!.stringValue!.utf8), test["name"]!.stringValue!)
                XCTAssertEqual(try UserMessageEncoder.wireBytes(result), Data(test["wire"]!.stringValue!.utf8), test["name"]!.stringValue!)
            } catch let error as UnsupportedPermissionModeError {
                XCTAssertEqual(error.errorDescription, test["error"]?.stringValue, test["name"]!.stringValue!)
            }
        }
    }
}
