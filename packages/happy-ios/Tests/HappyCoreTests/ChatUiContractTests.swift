import Foundation
import HappyCrypto
import HappyWire
import XCTest
@testable import HappyCore

/// Chat UI against `@slopus/happy-agent-client`'s own contract, vendored
/// in `Fixtures/chat-ui` by `scripts/vendor-chat-ui.mjs`: `ui.schema.json`
/// and the `permission`, `payload` and `documents` vectors of
/// `actions.fixtures.json`. (`MediaRowsTests` reads its `mediaLayout`.)
final class ChatUiContractTests: XCTestCase {
    private func url(_ file: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: file, withExtension: nil, subdirectory: "Fixtures/chat-ui"), file)
    }

    private func json(_ file: String) throws -> JSONValue { try JSONValue.decode(Data(contentsOf: url(file))) }

    /// The files are the ones the record names, byte for byte: taken again
    /// with the script, never edited.
    func testTheVendoredFilesAreTheOnesRecorded() throws {
        let record = try json("vendored.json")
        XCTAssertEqual(record["commit"]?.stringValue?.count, 40)
        let recorded = try XCTUnwrap(record["sha256"]?.objectValue)
        XCTAssertEqual(Set(recorded.keys), ["ui.schema.json", "actions.fixtures.json"])
        for (file, hash) in recorded {
            let digest = Hashing.sha256(try Data(contentsOf: url(file))).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(.string(digest), hash, "\(file) is not what vendored.json records; run scripts/vendor-chat-ui.mjs")
        }
    }

    /// Each action the phone sends is the schema's: its permission, and
    /// the payload fields kept are the schema's less its secret ones.
    func testTheActionsThePhoneSendsAreTheSchemas() throws {
        let schema = try json("ui.schema.json")
        let secret = try XCTUnwrap(schema["secretKeyword"]?.stringValue)
        XCTAssertFalse(UiCatalog.actions.isEmpty)
        for (type, ours) in UiCatalog.actions {
            let parts = type.split(separator: ".").map(String.init)
            let declared = try XCTUnwrap(schema["components"]?[parts[0]]?["actions"]?[parts[1]], type)
            XCTAssertEqual(.string(ours.permission), declared["permission"], type)
            let fields = try XCTUnwrap(declared["payload"]?["properties"]?.objectValue, type)
            XCTAssertEqual(ours.kept, Set(fields.filter { $0.value[secret] != .bool(true) }.keys), type)
        }
    }

    /// The owner holds every permission, a member the member set, a viewer
    /// none.
    func testPermissionsResolveAsTheClients() throws {
        let member = Set(try XCTUnwrap(json("ui.schema.json")["memberPermissions"]?.arrayValue).compactMap(\.stringValue))
        let vectors = try XCTUnwrap(json("actions.fixtures.json")["permission"]?.arrayValue).filter { UiCatalog.actions[$0["action"]?.stringValue ?? ""] != nil }
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let type = try XCTUnwrap(vector["action"]?.stringValue)
            XCTAssertEqual(UiCatalog.actions[type].map { .string($0.permission) }, vector["permission"], type)
            XCTAssertEqual(UiCatalog.allowed(type, granted: nil), vector["allowed"]?["owner"]?.boolValue, type)
            XCTAssertEqual(UiCatalog.allowed(type, granted: member), vector["allowed"]?["member"]?.boolValue, type)
            XCTAssertEqual(UiCatalog.allowed(type, granted: []), vector["allowed"]?["viewer"]?.boolValue, type)
        }
    }

    /// What the phone holds of an action on its way is the client's
    /// redacted form, for every valid payload of the vectors: no secret
    /// field, and nothing at all of an action it doesn't send.
    func testAHeldActionIsTheClientsRedactedForm() throws {
        let vectors = try XCTUnwrap(json("actions.fixtures.json")["payload"]?.arrayValue).filter { $0["schemaValid"] == .bool(true) }
        XCTAssertTrue(vectors.contains { $0["action"]?["payload"] != $0["redacted"] }, "some vector holds a secret")
        XCTAssertTrue(vectors.contains { UiCatalog.actions[$0["action"]?["type"]?.stringValue ?? ""] != nil }, "some vector is an action the phone sends")
        for vector in vectors {
            let action = try XCTUnwrap(vector["action"]).decode(as: UiAction.self)
            XCTAssertEqual(UiCatalog.redacted(action), UiAction(type: action.type, payload: try XCTUnwrap(vector["redacted"])), "\(vector)")
        }
    }

    /// Every document of the vectors reads. The phone draws `file_tree`,
    /// `media` and `default_model` where the client says their props fit,
    /// and the fallback line for the rest: another type, or props that
    /// don't fit.
    func testEveryDocumentDrawsWhatFitsAndFallsBackForTheRest() throws {
        let item = AgentWire.MediaItem(kind: "image", name: "a.png", mimeType: "image/png")
        let media = (0..<24).map { Media(toolCallId: "call", index: $0, item: item) }
        let vectors = try XCTUnwrap(json("actions.fixtures.json")["documents"]?.arrayValue)
        var drawn = 0, lines = 0
        for vector in vectors {
            let block = JSONValue.object(["type": .string("ui"), "ui": try XCTUnwrap(vector["document"])])
            guard case .ui(let document) = try block.decode(as: AgentWire.Block.self) else { return XCTFail("\(vector)") }
            let fits = try XCTUnwrap(vector["drawn"]?.arrayValue).map { $0 == .bool(true) }
            XCTAssertEqual(fits.count, document.components.count)
            for (component, fits) in zip(document.components, fits) {
                let pieces = UiShown.pieces(component, document: document.id, message: "a1", media: media)
                XCTAssertEqual(pieces.count, 1, component.id)
                let expected = fits && ["file_tree", "media", "default_model"].contains(component.type)
                switch pieces.first {
                case .ui(let shown)?:
                    if case .line(let line) = shown.kind {
                        XCTAssertFalse(expected, "\(vector)")
                        XCTAssertEqual(line, component.fallback)
                        lines += 1
                    } else {
                        XCTAssertTrue(expected, "\(vector)")
                        drawn += 1
                    }
                case .mediaRows?:
                    XCTAssertTrue(expected, "\(vector)")
                    drawn += 1
                default:
                    XCTFail("\(vector)")
                }
            }
        }
        XCTAssertGreaterThan(drawn, 0)
        XCTAssertGreaterThan(lines, 0)
    }
}
