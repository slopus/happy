import XCTest
import HappyWire
@testable import HappyCore

final class TabOpeningTests: XCTestCase {
    private actor Server: AgentTransport {
        private(set) var created: [JSONValue] = []
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            let response: JSONValue
            switch (method, path) {
            case ("GET", "/v0/bootstrap/desktop"):
                response = .object(["profile": .object(["userId": .string(credential)])])
            case ("GET", "/v0/surfaces"):
                response = .object(["surfaces": .array(created)])
            case ("POST", "/v0/surfaces"):
                let value = try JSONDecoder().decode(JSONValue.self, from: body ?? Data())
                let tab: JSONValue = .object([
                    "id": value["id"]!, "creatorUserId": .string(credential),
                    "members": .array([.object(["userId": .string(credential)])]),
                    "target": .object(["type": "artifact", "state": "available", "artifactId": value["artifactId"]!]),
                ])
                created.append(tab)
                response = .object(["surface": tab])
            default: return HTTP1Response(status: 404)
            }
            return HTTP1Response(status: 200, body: try JSONEncoder().encode(response))
        }
        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    func testDeliveryUsesBoundAccountAndReopeningDoesNotCreateAgain() async throws {
        let server = Server()
        let first = AgentClient(transport: server, token: "member-one")
        let second = AgentClient(transport: server, token: "member-two")
        let creationId = ClientID.make()
        try await first.openTab(kind: "artifact", id: "shared", mutationId: creationId)
        try await first.openTab(kind: "artifact", id: "shared", mutationId: ClientID.make())
        try await second.openTab(kind: "artifact", id: "shared", mutationId: ClientID.make())
        let tabs = await server.created
        XCTAssertEqual(tabs.count, 2)
        XCTAssertEqual(tabs.first?["id"]?.stringValue, creationId)
        XCTAssertEqual(tabs.map { $0["creatorUserId"]?.stringValue }, ["member-one", "member-two"])
        XCTAssertNotNil(creationId.range(of: "^[a-z][a-z0-9]{23}$", options: .regularExpression))
    }

    private func snapshot(_ tabs: String = "[]", user: String = "\"me\"") throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"profile":{"userId":\(user)},"bots":[{"id":"bot1","name":"Bot","agent":{"id":"a1"}}],"surfaces":\(tabs)}
        """.utf8))
    }

    private func tab(member: String, creator: String, id: String = "tab1") -> String {
        """
        {"id":"\(id)","creatorUserId":\(creator),"members":[{"userId":\(member)}],"target":{"state":"available","type":"bot","botId":"bot1"}}
        """
    }

    func testOpeningAddsReferenceButNotForUnownedSubagent() throws {
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "a1", snapshot: try snapshot()), .create(.init(kind: "bot", id: "bot1", name: "Bot")))
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "child", snapshot: try snapshot()), .none)
        XCTAssertEqual(TabOpening.action(kind: "surface", id: "monitor1", snapshot: .null), .join("monitor1"))
    }

    func testReopenKeepsJoinedIdentityAndDoesNotTakeAnotherMembersTab() throws {
        let other = tab(member: "\"other\"", creator: "\"other\"")
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "a1", snapshot: try snapshot("[\(other)]")), .create(.init(kind: "bot", id: "bot1", name: "Bot")))
        let mine = tab(member: "\"me\"", creator: "\"other\"", id: "mine")
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "a1", snapshot: try snapshot("[\(other),\(mine)]")), .none)
        let left = tab(member: "\"other\"", creator: "\"me\"", id: "left")
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "a1", snapshot: try snapshot("[\(other),\(left)]")), .join("left"))
    }

    func testStandaloneMembershipAndUnavailableTargets() throws {
        XCTAssertEqual(TabOpening.action(kind: "agent", id: "a1", snapshot: try snapshot("[\(tab(member: "null", creator: "null"))]", user: "null")), .none)
        XCTAssertEqual(TabOpening.action(kind: "artifact", id: "a", snapshot: try snapshot("[{\"target\":{\"state\":\"unavailable\",\"type\":\"artifact\"}}]")), .create(.init(kind: "artifact", id: "a", name: "Untitled")))
    }
}