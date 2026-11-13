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

    /// Legacy: a server that still flags a Policy vault keeps the documents
    /// there, and its settings show none; a new one (a Files vault only)
    /// serves them. Delete with `PolicyDocument.served`.
    func testOnlyAServerWithoutAPolicyVaultServesThemFromItsSettings() {
        let files = AgentWire.Surface(id: "files", type: "vault", name: "Files", access: "write")
        let policy = AgentWire.Surface(id: "policy", type: "vault", name: "Policy", access: "read", policyVault: true)
        XCTAssertEqual(PolicyDocument.served(vaults: [files]), true)
        XCTAssertEqual(PolicyDocument.served(vaults: []), true)
        XCTAssertEqual(PolicyDocument.served(vaults: [files, policy]), false)
        XCTAssertNil(PolicyDocument.served(vaults: nil), "not read yet")
    }
}
