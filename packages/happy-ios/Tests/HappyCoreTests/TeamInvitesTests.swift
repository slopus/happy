import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Inviting teammates to a Happy Cloud server, as onboarding's teammates
/// step does: by email, a link where the server can't send email, and what
/// each refusal means to the step.
final class TeamInvitesTests: XCTestCase {
    func testAnEmailInviteSendsTheAddressAndReadsWhatWasMade() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/invites", 201, #"{"invite":{"id":"inv1","link":"https://acme.happy.engineering/join#t","expiresAt":"2026-11-20T00:00:00Z","role":"member","deliveryStatus":"failed"}}"#)
        let invite = try await AgentClient(transport: server, token: "t").invite(email: "ana@acme.com", mutationId: "m1")
        XCTAssertEqual(invite, TeamInvite(id: "inv1", link: "https://acme.happy.engineering/join#t", role: "member", deliveryStatus: "failed"))
        XCTAssertTrue(invite.emailFailed)
        let bodies = await server.bodies
        XCTAssertEqual(bodies, [["email": "ana@acme.com", "mutationId": "m1"]], "only the address and the mutation: the server refuses unknown fields")

        await server.answer("POST /v0/invites", 201, #"{"invite":{"id":"inv2","link":"https://acme.happy.engineering/join#u","expiresAt":1,"role":"member"}}"#)
        let link = try await AgentClient(transport: server, token: "t").invite(email: nil, mutationId: "m2")
        XCTAssertFalse(link.emailFailed)
        let linkBody = await server.bodies.last
        XCTAssertEqual(linkBody, ["mutationId": "m2"], "a link invite names no address")
    }

    func testEachRefusalSaysWhatTheStepDoesNext() async throws {
        let server = ProvidersServer()
        let client = AgentClient(transport: server, token: "t")
        await server.answer("POST /v0/invites", 503, #"{"code":"email_not_configured","error":"Email isn't set up."}"#)
        await XCTAssertThrowsAsync(try await client.invite(email: "ana@acme.com"), TeamInviteRefusal.emailNotConfigured)
        await server.answer("POST /v0/invites", 400, #"{"code":"invalid","error":"That address can't get invites."}"#)
        await XCTAssertThrowsAsync(try await client.invite(email: "ana@acme.com"), TeamInviteRefusal.refused("That address can't get invites."))
        // No route at all: a server from before invites.
        await XCTAssertThrowsAsync(try await AgentClient(transport: ProvidersServer(), token: "t").invite(email: "ana@acme.com"), TeamInviteRefusal.unsupported)
    }

    func testAnAddressLooksValidOnlyWhenWhole() {
        for text in ["ana@acme.com", "a.b+c@mail.acme.co.uk"] { XCTAssertTrue(EmailAddress.looksValid(text), text) }
        for text in ["", "ana", "ana@", "@acme.com", "ana@acme", "ana@acme.", "ana @acme.com", "a@b@c.com"] { XCTAssertFalse(EmailAddress.looksValid(text), text) }
    }
}

private func XCTAssertThrowsAsync<T>(_ expression: @autoclosure () async throws -> T, _ expected: TeamInviteRefusal,
                                     file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("didn't throw", file: file, line: line)
    } catch {
        XCTAssertEqual(error as? TeamInviteRefusal, expected, file: file, line: line)
    }
}
