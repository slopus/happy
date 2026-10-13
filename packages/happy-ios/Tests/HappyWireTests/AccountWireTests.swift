import Foundation
import XCTest
@testable import HappyWire

/// The profile, account and project updates, and the account-level
/// payloads Settings reads.
final class AccountWireTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testProfileToleratesABrokenAvatarAndGitHub() throws {
        let profile = try decode(AccountProfile.self, """
        {"id":"u","timestamp":5,"firstName":null,"lastName":"L","username":"x","avatar":{"oops":1},
         "github":"not an object","connectedServices":["anthropic","openai"]}
        """)
        XCTAssertNil(profile.avatar)
        XCTAssertNil(profile.github)
        XCTAssertEqual(profile.displayName, "L")
        XCTAssertEqual(profile.connectedServices, ["anthropic", "openai"])
    }

    func testDisplayNameFallsBackToGitHub() throws {
        let named = AccountProfile(id: "u", timestamp: 1, github: GitHubProfile(id: 1, login: "octo", name: "Octo Cat"))
        XCTAssertEqual(named.displayName, "Octo Cat")
        let login = AccountProfile(id: "u", timestamp: 1, github: GitHubProfile(id: 1, login: "octo"))
        XCTAssertEqual(login.displayName, "octo")
        XCTAssertNil(AccountProfile(id: "u", timestamp: 1).displayName)
    }

    func testUpdateAccountPatchesOnlyWhatItCarries() throws {
        let update = try decode(UpdateContainer.self, """
        {"id":"x","seq":1,"createdAt":9,"body":{"t":"update-account","id":"u","firstName":"Ada","github":null}}
        """)
        guard case .updateAccount(let body) = update.body else { return XCTFail("\(update.body)") }
        XCTAssertEqual(body.firstName, .some("Ada"))
        XCTAssertTrue(body.lastName == nil, "absent")
        XCTAssertEqual(body.github, .some(nil), "null disconnects")
        XCTAssertTrue(body.patchesProfile)

        let settingsOnly = try decode(UpdateContainer.self, """
        {"id":"x","seq":1,"createdAt":9,"body":{"t":"update-account","id":"u","settings":{"version":2,"value":"c"}}}
        """)
        guard case .updateAccount(let settings) = settingsOnly.body else { return XCTFail() }
        XCTAssertFalse(settings.patchesProfile)
    }

    func testProjectUpdates() throws {
        for (type, expected) in [
            ("new-project", UpdateBody.newProject(projectId: "p")),
            ("update-project", .updateProject(projectId: "p")),
            ("delete-project", .deleteProject(projectId: "p")),
        ] {
            let update = try decode(UpdateContainer.self, #"{"id":"x","seq":1,"createdAt":0,"body":{"t":"\#(type)","projectId":"p"}}"#)
            guard case let body = update.body, "\(body)" == "\(expected)" else { return XCTFail("\(type): \(update.body)") }
        }
    }

    func testProjectsSkipMalformedRows() throws {
        let response = try decode(ProjectsResponse.self, """
        {"projects":[{"id":"p","externalId":"e","metadata":"m","metadataVersion":1,"dataEncryptionKey":null,"createdAt":1,"updatedAt":2},
                     {"id":"broken"}]}
        """)
        XCTAssertEqual(response.projects.map(\.id), ["p"])
    }

    func testUsageAndPushTokens() throws {
        let usage = try decode(UsageResponse.self, #"{"usage":[{"timestamp":1,"tokens":{"opus":10},"cost":{"opus":0.1},"reportCount":2}]}"#)
        XCTAssertEqual(usage.usage.first?.tokens["opus"], 10)
        let tokens = try decode(PushTokensResponse.self, #"{"tokens":[{"id":"t","token":"ExponentPushToken[x]","createdAt":1,"updatedAt":2}]}"#)
        XCTAssertEqual(tokens.tokens.first?.id, "t")
        let query = try JSONValue.decode(JSONEncoder().encode(UsageQuery(startTime: 1, endTime: 2, groupBy: .hour)))
        XCTAssertEqual(query, .object(["startTime": .number(1), "endTime": .number(2), "groupBy": .string("hour")]))
    }

    func testActivityCarriesThinking() throws {
        let event = try decode(EphemeralEvent.self, #"{"type":"activity","id":"s","active":true,"activeAt":5,"thinking":true}"#)
        XCTAssertEqual(event, .activity(sessionId: "s", active: true, activeAt: 5, thinking: true))
    }
}
