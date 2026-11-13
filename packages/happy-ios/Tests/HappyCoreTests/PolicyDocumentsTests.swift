import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A Happy Cloud server's instructions and security policy, read and
/// replaced through its settings, and only on a server that keeps them
/// there.
final class PolicyDocumentsTests: XCTestCase {
    func testEachDocumentIsReadAndPutUnderItsOwnKey() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/config/instructions", 200, ##"{"instructions":"# Acme"}"##)
        await server.answer("GET /v0/config/security", 200, #"{"policy":""}"#)
        await server.answer("PUT /v0/config/security", 200, ##"{"policy":"No secrets.\n"}"##)
        let client = AgentClient(transport: server, token: "t")
        let instructions = try await client.policyDocument(.instructions)
        XCTAssertEqual(instructions, "# Acme")
        let security = try await client.policyDocument(.security)
        XCTAssertEqual(security, "", "a missing document reads as empty")
        let kept = try await client.putPolicyDocument(.security, "No secrets.")
        XCTAssertEqual(kept, "No secrets.\n", "the document as the server kept it")
        let bodies = await server.rawBodies
        XCTAssertEqual(bodies.last, .object(["policy": .string("No secrets.")]))
        XCTAssertEqual(PolicyDocument.instructions.limit, 256 * 1024)
        XCTAssertEqual(PolicyDocument.security.limit, 32 * 1024)
    }

    func testOnlyOwnersEditThem() throws {
        let owner = try JSONDecoder().decode(Permissions.self, from: Data(#"{"granted":["content.write","policy.edit"]}"#.utf8))
        XCTAssertTrue(RoleGate.cloud(owner).allows(.policyEdit))
        XCTAssertFalse(RoleGate.cloud(Permissions(granted: ["content.write", "config.manage"])).allows(.policyEdit))
        XCTAssertFalse(RoleGate.cloud(nil).allows(.policyEdit), "unread permissions edit nothing")
    }

    /// A server serves them from its settings when its permission catalog
    /// has `policy.edit`, granted or not, whether or not it still keeps a
    /// Policy vault beside them; one whose catalog doesn't (deployed
    /// before) shows none.
    func testAServerWhoseCatalogHasPolicyEditServesThem() throws {
        func read(_ json: String) throws -> Permissions { try JSONDecoder().decode(Permissions.self, from: Data(json.utf8)) }
        let member = try read(#"{"role":"member","granted":["content.write"],"permissions":[{"id":"content.write","description":"x"},{"id":"policy.edit","description":"y"},{"bad":1}]}"#)
        XCTAssertEqual(member.known, ["content.write", "policy.edit"])
        XCTAssertEqual(PolicyDocument.served(member), true, "shown read-only to a member")
        XCTAssertFalse(RoleGate.cloud(member).allows(.policyEdit))
        let deployed = try read(#"{"role":"owner","granted":["content.write","config.manage"],"permissions":[{"id":"content.write","description":"x"}]}"#)
        XCTAssertEqual(PolicyDocument.served(deployed), false)
        XCTAssertEqual(PolicyDocument.served(try read(#"{"granted":["content.write"]}"#)), false, "no catalog, nothing served")
        XCTAssertNil(PolicyDocument.served(nil), "not read yet")
    }
}
