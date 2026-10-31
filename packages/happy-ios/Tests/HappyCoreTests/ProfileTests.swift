import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// The person's own profile on a paired computer: the routes as
/// happy-agent's client calls them, and what the page shows while a
/// change is on its way.
final class ProfileTests: XCTestCase {
    private actor ProfileServer: AgentTransport {
        struct Sent: Equatable { var method: String; var path: String; var headers: [String: String]; var body: Data? }
        private(set) var sent: [Sent] = []
        var version = "0199a000-0000-7000-8000-000000000001"
        var name: String? = "Steve"
        var thumbhash: String?
        /// PATCHes refused as stale before one goes through.
        var conflicts = 0

        func setConflicts(_ count: Int) { conflicts = count }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            sent.append(Sent(method: method, path: path, headers: headers, body: body))
            switch (method, path) {
            case ("GET", "/v0/profile"):
                return answer()
            case ("PATCH", "/v0/profile"):
                if conflicts > 0 || headers["If-Match"] != version {
                    conflicts = max(0, conflicts - 1)
                    version = "0199a000-0000-7000-8000-00000000000\(sent.count)"
                    return HTTP1Response(status: 409, body: Data(#"{"error":"The profile has changed.","code":"version_conflict"}"#.utf8))
                }
                let json = try JSONDecoder().decode(JSONValue.self, from: body ?? Data())
                name = json["name"]?.stringValue
                version = "0199a000-0000-7000-8000-00000000009\(sent.count)"
                return answer()
            case ("PUT", "/v0/profile/photo"):
                thumbhash = "abc"
                return answer()
            case ("DELETE", "/v0/profile/photo"):
                thumbhash = nil
                return answer()
            case ("GET", "/v0/profile/photo"):
                if headers["If-None-Match"] == "\"p1\"" { return HTTP1Response(status: 304) }
                return HTTP1Response(status: 200, headers: ["etag": "\"p1\"", "content-type": "image/jpeg"], body: Data([1, 2, 3]))
            default:
                return HTTP1Response(status: 404)
            }
        }

        private func answer() -> HTTP1Response {
            let photo = thumbhash.map { #"{"thumbhash":"\#($0)"}"# } ?? "null"
            let name = name.map { "\"\($0)\"" } ?? "null"
            return HTTP1Response(status: 200, body: Data(#"{"profile":{"email":null,"name":\#(name),"photo":\#(photo),"userId":null,"updatedAt":1,"version":"\#(version)"}}"#.utf8))
        }

        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    func testTheProfileIsReadAsTheDaemonWritesIt() async throws {
        let server = ProfileServer()
        let profile = try await AgentClient(transport: server, token: "t").profile()
        XCTAssertEqual(profile.name, "Steve")
        XCTAssertNil(profile.photo)
        XCTAssertNil(profile.userId)
        XCTAssertEqual(profile.version, "0199a000-0000-7000-8000-000000000001")
    }

    /// The name is saved over the version the page read; a stale one reads
    /// the newer version and saves over that, once.
    func testANameSavesOverTheVersionReadAndRetriesOnceOnAConflict() async throws {
        let server = ProfileServer()
        let client = AgentClient(transport: server, token: "t")
        let read = try await client.profile()
        let saved = try await client.renameProfile("Steve K", version: read.version)
        XCTAssertEqual(saved.name, "Steve K")
        var sent = await server.sent
        XCTAssertEqual(sent.map(\.method), ["GET", "PATCH"])
        XCTAssertEqual(sent[1].headers["If-Match"], read.version)
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(sent[1].body))
        XCTAssertEqual(body["name"], .string("Steve K"))
        XCTAssertNotNil(body["mutationId"]?.stringValue)

        // Changed on another device since: refused, read again, saved.
        let stale = saved.version
        await server.setConflicts(1)
        let again = try await client.renameProfile("Steve", version: stale)
        XCTAssertEqual(again.name, "Steve")
        sent = await server.sent
        XCTAssertEqual(sent.suffix(3).map(\.method), ["PATCH", "GET", "PATCH"])
        XCTAssertEqual(sent[sent.count - 3].headers["If-Match"], stale)
        XCTAssertNotEqual(sent[sent.count - 1].headers["If-Match"], stale, "the retry named the stale version again")

        // Refused twice: the second refusal is the answer.
        await server.setConflicts(2)
        do {
            _ = try await client.renameProfile("Nope", version: again.version)
            XCTFail("a second conflict was not reported")
        } catch AgentClientError.status(409, _, _) {}
        sent = await server.sent
        XCTAssertEqual(sent.suffix(3).map(\.method), ["PATCH", "GET", "PATCH"], "more than one retry")
    }

    /// The picture goes as its own bytes and type, not as JSON; the daemon
    /// answers with the profile carrying its ThumbHash.
    func testThePhotoIsSentAsItsBytesAndRemoved() async throws {
        let server = ProfileServer()
        let client = AgentClient(transport: server, token: "t")
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let set = try await client.setProfilePhoto(jpeg, contentType: "image/jpeg")
        XCTAssertEqual(set.photo?.thumbhash, "abc")
        var sent = await server.sent
        XCTAssertEqual(sent.last?.method, "PUT")
        XCTAssertEqual(sent.last?.path, "/v0/profile/photo")
        XCTAssertEqual(sent.last?.headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(sent.last?.body, jpeg)

        let bytes = try await client.profilePhoto()
        XCTAssertEqual(bytes?.data, Data([1, 2, 3]))
        XCTAssertEqual(bytes?.etag, "\"p1\"")
        let unchanged = try await client.profilePhoto(etag: "\"p1\"")
        XCTAssertNil(unchanged, "a 304 is no new bytes")

        let removed = try await client.removeProfilePhoto()
        XCTAssertNil(removed.photo)
        sent = await server.sent
        XCTAssertEqual(sent.last?.method, "DELETE")
    }

    /// A change shows at once and stays until its answer, whatever older
    /// read lands meanwhile; a failure shows the computer's again.
    func testAChangeHoldsUntilItsAnswerWithoutFlickeringBack() {
        let v1 = AgentWire.Profile(name: "Steve", photo: .init(thumbhash: "old"), version: "0199a000-0000-7000-8000-000000000001")
        let v2 = AgentWire.Profile(name: "Steve K", photo: .init(thumbhash: "old"), version: "0199a000-0000-7000-8000-000000000002")
        var state = ProfileState()
        XCTAssertEqual(state.name, "")
        XCTAssertFalse(state.hasPhoto)
        state.heard(v1)
        XCTAssertEqual(state.name, "Steve")

        state.holdName("Steve K")
        XCTAssertEqual(state.name, "Steve K", "the new name shows at once")
        state.heard(v1)
        XCTAssertEqual(state.name, "Steve K", "a read landing before the answer put the old name back")
        state.nameSaved("Steve K", v2)
        XCTAssertEqual(state.name, "Steve K")
        XCTAssertNil(state.pendingName)
        state.heard(v1)
        XCTAssertEqual(state.profile, v2, "an older read replaced a newer answer")

        state.holdName("Typo")
        state.nameFailed("Typo")
        XCTAssertEqual(state.name, "Steve K", "a failed save left its name up")

        // Two saves in a row: the first's answer leaves the second showing.
        state.holdName("First")
        state.holdName("Second")
        state.nameSaved("First", AgentWire.Profile(name: "First", photo: .init(thumbhash: "old"), version: "0199a000-0000-7000-8000-000000000002a"))
        XCTAssertEqual(state.name, "Second", "an earlier save's answer put its own name over a later one")
        state.nameSaved("Second", AgentWire.Profile(name: "Second", photo: .init(thumbhash: "old"), version: "0199a000-0000-7000-8000-000000000002b"))
        XCTAssertEqual(state.name, "Second")
        XCTAssertNil(state.pendingName)

        XCTAssertEqual(state.thumbhash, "old")
        state.holdPhoto(.removing)
        XCTAssertFalse(state.hasPhoto)
        XCTAssertNil(state.thumbhash)
        state.photoFailed(.removing)
        XCTAssertTrue(state.hasPhoto)
        state.holdPhoto(.uploading("picked"))
        XCTAssertTrue(state.hasPhoto)
        XCTAssertNil(state.thumbhash, "the old picture's placeholder showed under the new one")
        let v3 = AgentWire.Profile(name: "Steve K", photo: .init(thumbhash: "new"), version: "0199a000-0000-7000-8000-000000000003")
        state.photoSaved(.uploading("picked"), v3)
        XCTAssertEqual(state.thumbhash, "new")
        XCTAssertNil(state.pendingPhoto)
    }
}
