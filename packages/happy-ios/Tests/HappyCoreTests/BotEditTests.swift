import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A personal bot's settings page (`BotEdit`): what may be saved, what a
/// save sends (`PATCH /v0/bots/:id` over the version read, only what
/// changed, then the picture on its own route), and what a save that
/// lost a race to another change does.
final class BotEditTests: XCTestCase {
    private static func bot(name: String = "Release helper", instructions: String? = "Ship on Fridays.", version: String = "v1") -> AgentWire.Bot {
        AgentWire.Bot(id: "helper", name: name, systemKey: nil, status: "active", avatar: nil, version: version, agent: nil,
                      kind: "personal", isAdmin: false, editable: true, instructions: instructions, revision: 1)
    }

    // MARK: The form

    func testNothingChangedSavesNothing() {
        let edit = BotEdit(Self.bot())
        XCTAssertEqual(edit.name, "Release helper")
        XCTAssertEqual(edit.instructions, "Ship on Fridays.")
        XCTAssertFalse(edit.isDirty)
        XCTAssertFalse(edit.canSave)
        XCTAssertNil(edit.changes(mutationId: "m"))
        // Spaces around the name aren't a change.
        var padded = edit
        padded.name = "  Release helper "
        XCTAssertFalse(padded.isDirty)
        // A bot sent without instructions edits empty ones.
        XCTAssertEqual(BotEdit(Self.bot(instructions: nil)).instructions, "")
    }

    func testOnlyWhatChangedIsSent() throws {
        var edit = BotEdit(Self.bot())
        edit.name = " Shipper "
        XCTAssertTrue(edit.canSave)
        XCTAssertEqual(edit.changes(mutationId: "m"), .object(["name": .string("Shipper"), "mutationId": .string("m")]))
        edit.name = "Release helper"
        edit.instructions = "Ship on Fridays.\nNever on Mondays."
        XCTAssertEqual(edit.changes(mutationId: "m"), .object(["instructions": .string("Ship on Fridays.\nNever on Mondays."), "mutationId": .string("m")]))
        // Emptied instructions are a change, sent as empty.
        edit.instructions = ""
        XCTAssertEqual(edit.changes(mutationId: "m")?["instructions"], .string(""))
        // A picture alone is a change with no PATCH.
        var photo = BotEdit(Self.bot())
        photo.photo = Data([1])
        XCTAssertTrue(photo.canSave)
        XCTAssertNil(photo.changes(mutationId: "m"))
    }

    func testWhatStopsASave() {
        var edit = BotEdit(Self.bot())
        edit.name = "   "
        XCTAssertEqual(edit.problem, .nameMissing)
        XCTAssertFalse(edit.canSave)
        edit.name = String(repeating: "a", count: BotEdit.nameLimit)
        XCTAssertNil(edit.problem)
        edit.name += "a"
        XCTAssertEqual(edit.problem, .nameTooLong)
        edit.name = "Two\nlines"
        XCTAssertEqual(edit.problem, .nameTooLong)
        edit.name = "Fine"
        // 32 KiB in UTF-8, not in characters.
        edit.instructions = String(repeating: "é", count: BotEdit.instructionsLimit / 2)
        XCTAssertNil(edit.problem)
        edit.instructions += "a"
        XCTAssertEqual(edit.problem, .instructionsTooLong)
        XCTAssertFalse(edit.canSave)
    }

    /// A newer read under the form: what wasn't touched here follows it,
    /// what was stays; a collision is a change elsewhere to a field
    /// changed here, to something else.
    func testANewerReadRebasesWhatWasntTouched() {
        var edit = BotEdit(Self.bot())
        edit.instructions = "Mine"
        let newer = Self.bot(name: "Renamed elsewhere", instructions: "Ship on Fridays.", version: "v2")
        XCTAssertFalse(edit.collides(with: newer))
        edit.rebase(on: newer)
        XCTAssertEqual(edit.name, "Renamed elsewhere")
        XCTAssertEqual(edit.instructions, "Mine")
        XCTAssertEqual(edit.base.version, "v2")
        XCTAssertEqual(edit.changes(mutationId: "m"), .object(["instructions": .string("Mine"), "mutationId": .string("m")]))
        XCTAssertTrue(edit.collides(with: Self.bot(name: "Renamed elsewhere", instructions: "Theirs", version: "v3")))
        XCTAssertFalse(edit.collides(with: Self.bot(name: "Renamed elsewhere", instructions: "Mine", version: "v3")), "the same change twice is no collision")
    }

    // MARK: Saving

    private actor BotServer: AgentTransport {
        struct Sent: Equatable { var method: String; var path: String; var headers: [String: String]; var body: Data? }
        private(set) var sent: [Sent] = []
        var version = "v1"
        var name = "Release helper"
        var instructions = "Ship on Fridays."
        var thumbhash: String?
        /// A change made elsewhere before the next PATCH lands.
        var elsewhere: (name: String?, instructions: String?)?

        func changeElsewhere(name: String? = nil, instructions: String? = nil) { elsewhere = (name, instructions) }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            sent.append(Sent(method: method, path: path, headers: headers, body: body))
            if method != "GET", let change = elsewhere {
                elsewhere = nil
                if let name = change.name { self.name = name }
                if let instructions = change.instructions { self.instructions = instructions }
                version = "v\(sent.count)e"
            }
            switch (method, path) {
            case ("GET", "/v0/bots/helper"):
                return answer()
            case ("PATCH", "/v0/bots/helper"):
                guard headers["If-Match"] == version else { return Self.stale }
                let json = try JSONDecoder().decode(JSONValue.self, from: body ?? Data())
                if let name = json["name"]?.stringValue { self.name = name }
                if let instructions = json["instructions"]?.stringValue { self.instructions = instructions }
                version = "v\(sent.count)"
                return answer()
            case ("PUT", "/v0/bots/helper/avatar"):
                guard headers["If-Match"] == version else { return Self.stale }
                thumbhash = "th"
                version = "v\(sent.count)"
                return answer()
            default:
                return HTTP1Response(status: 404)
            }
        }

        private static let stale = HTTP1Response(status: 409, body: Data(#"{"error":"The bot has changed.","code":"version_conflict"}"#.utf8))

        private func answer() -> HTTP1Response {
            let bot: JSONValue = .object([
                "id": .string("helper"), "name": .string(name), "kind": .string("personal"), "isAdmin": .bool(false),
                "editable": .bool(true), "instructions": .string(instructions), "revision": .number(2), "version": .string(version),
                "avatar": thumbhash.map { .object(["kind": .string("image"), "thumbhash": .string($0), "source": .string("user")]) } ?? .null,
            ])
            return HTTP1Response(status: 200, body: try! JSONEncoder().encode(JSONValue.object(["bot": bot])))
        }

        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    /// The PATCH names the version read and sends only what changed; the
    /// picture follows on its own route, over the version the PATCH made.
    func testASaveSendsTheChangesThenThePicture() async throws {
        let server = BotServer()
        let client = AgentClient(transport: server, token: "t")
        var edit = BotEdit(try await client.bot("helper"))
        edit.instructions = "Never on Mondays."
        edit.photo = Data([0xFF, 0xD8])
        let saved = try await edit.save(with: client, mutationId: "m1")
        XCTAssertEqual(saved.instructions, "Never on Mondays.")
        XCTAssertEqual(saved.avatar?.thumbhash, "th")
        let sent = await server.sent
        XCTAssertEqual(sent.map { "\($0.method) \($0.path)" }, ["GET /v0/bots/helper", "PATCH /v0/bots/helper", "PUT /v0/bots/helper/avatar"])
        XCTAssertEqual(sent[1].headers["If-Match"], "v1")
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(sent[1].body))
        XCTAssertEqual(body, .object(["instructions": .string("Never on Mondays."), "mutationId": .string("m1")]))
        XCTAssertEqual(sent[2].headers["If-Match"], "v2", "the picture named the version before the PATCH")
        XCTAssertEqual(sent[2].headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(sent[2].body, Data([0xFF, 0xD8]))
    }

    /// Changed elsewhere in a field not touched here: read again, saved
    /// over the newer version once, with the same mutation.
    func testAStaleSaveRetriesOverAChangeThatDoesntCollide() async throws {
        let server = BotServer()
        let client = AgentClient(transport: server, token: "t")
        var edit = BotEdit(try await client.bot("helper"))
        edit.instructions = "Mine"
        await server.changeElsewhere(name: "Renamed elsewhere")
        let saved = try await edit.save(with: client, mutationId: "m1")
        XCTAssertEqual(saved.name, "Renamed elsewhere")
        XCTAssertEqual(saved.instructions, "Mine")
        let sent = await server.sent
        XCTAssertEqual(sent.map(\.method), ["GET", "PATCH", "GET", "PATCH"])
        XCTAssertEqual(sent[3].headers["If-Match"], "v2e")
        XCTAssertEqual(sent[1].body, sent[3].body, "the retry sent something else")
    }

    /// Changed elsewhere in the same field: nothing is saved over it; the
    /// page is handed the bot as it is now.
    func testAStaleSaveThatCollidesSavesNothing() async throws {
        let server = BotServer()
        let client = AgentClient(transport: server, token: "t")
        var edit = BotEdit(try await client.bot("helper"))
        edit.instructions = "Mine"
        await server.changeElsewhere(instructions: "Theirs")
        do {
            _ = try await edit.save(with: client)
            XCTFail("saved over a change made elsewhere")
        } catch BotEdit.SaveError.conflict(let newer) {
            XCTAssertEqual(newer.instructions, "Theirs")
        }
        let sent = await server.sent
        XCTAssertEqual(sent.map(\.method), ["GET", "PATCH", "GET"])
        let instructions = await server.instructions
        XCTAssertEqual(instructions, "Theirs")
    }

    /// The server's refusal (a shared bot, a role that may not) is the answer.
    func testARefusalIsThrown() async throws {
        let client = AgentClient(transport: RefusingServer(), token: "t")
        var edit = BotEdit(Self.bot())
        edit.name = "Nope"
        do {
            _ = try await edit.save(with: client)
            XCTFail("a refusal was not reported")
        } catch AgentClientError.status(403, _, _) {}
    }

    private actor RefusingServer: AgentTransport {
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            HTTP1Response(status: 403, body: Data(#"{"error":"A shared bot is not editable.","code":"forbidden"}"#.utf8))
        }
        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }
}
