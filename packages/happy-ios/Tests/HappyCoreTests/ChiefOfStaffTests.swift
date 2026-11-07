import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A Happy Cloud server's Chief of Staff: known by its `systemKey` alone,
/// never archived, and onboarding read as the server sends it.
final class ChiefOfStaffTests: XCTestCase {
    /// Named "Archivist" so a name could never be what tells it apart.
    static let desktop = #"""
    {"cursor":"c","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
     "bots":[
       {"id":"cos","name":"Archivist","systemKey":"chief_of_staff","status":"active","canArchive":true,"agent":{"id":"cos-agent","workspaceId":"w1","status":"idle"}},
       {"id":"helper","name":"Chief of Staff","status":"active","canArchive":true,"agent":{"id":"helper-agent","workspaceId":"w2","status":"idle"}}],
     "tasks":[],"taskMemberships":[],"surfaces":[]}
    """#

    func testTheChiefOfStaffIsKnownByItsSystemKeyAndNeverArchived() throws {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.desktop.utf8))
        let rows = SidebarRows.make(desktop, settings: [:])
        let cos = try XCTUnwrap(rows.first { $0.agentId == "cos-agent" })
        let helper = try XCTUnwrap(rows.first { $0.agentId == "helper-agent" })
        XCTAssertTrue(cos.isHappy)
        XCTAssertFalse(cos.canArchive, "the server's canArchive doesn't make the Chief of Staff archivable")
        XCTAssertFalse(helper.isHappy, "a bot named Chief of Staff is only a bot")
        XCTAssertTrue(helper.canArchive)
    }

    func testACloudServersOnboardingReadsWhole() throws {
        let json = #"""
        {"completed":false,
         "steps":{"providers":{"done":false,"signedIn":false},"profile":{"done":true},"project":{"done":false},
                  "chiefOfStaff":{"done":true,"name":"Morgan","botId":"cos"}},
         "server":{"completed":true,"steps":{"providers":{"done":true,"signedIn":true,"readyNow":false},"chiefOfStaff":{"done":true,"name":"Morgan","botId":"cos"}}},
         "member":{"completed":false,"steps":{"profile":{"done":false},"providers":{"done":true,"signedIn":false,"readyNow":true}}}}
        """#
        let onboarding = try JSONDecoder().decode(Onboarding.self, from: Data(json.utf8))
        XCTAssertFalse(onboarding.completed)
        XCTAssertEqual(onboarding.steps.chiefOfStaff, .init(done: true, name: "Morgan", botId: "cos"))
        XCTAssertEqual(onboarding.steps.providers, .init(done: false, signedIn: false))
        XCTAssertEqual(onboarding.steps.profile, .init(done: true))
        XCTAssertEqual(onboarding.server?.completed, true)
        XCTAssertEqual(onboarding.server?.steps.providers, .init(done: true, signedIn: true, readyNow: false))
        XCTAssertEqual(onboarding.server?.steps.chiefOfStaff?.name, "Morgan")
        XCTAssertEqual(onboarding.member?.completed, false)
        XCTAssertEqual(onboarding.member?.steps.profile, .init(done: false))
        XCTAssertEqual(onboarding.member?.steps.providers?.readyNow, true)
    }

    /// A standalone computer's: no Cloud parts, and a step it can't read
    /// is none rather than a failed read.
    /// A member with no name is asked theirs: the member's profile step
    /// says so, else the installation's; neither, and nothing is asked.
    func testANamelessMemberIsAskedTheirName() throws {
        func read(_ json: String) throws -> Onboarding { try JSONDecoder().decode(Onboarding.self, from: Data(json.utf8)) }
        let nameless = try read(#"{"completed":false,"steps":{"profile":{"done":true}},"member":{"completed":false,"steps":{"profile":{"done":false}}}}"#)
        XCTAssertEqual(nameless.needsName, true, "the member's step over the installation's")
        let named = try read(#"{"completed":true,"steps":{},"member":{"completed":true,"steps":{"profile":{"done":true}}}}"#)
        XCTAssertEqual(named.needsName, false)
        XCTAssertEqual(try read(#"{"completed":false,"steps":{"profile":{"done":false}}}"#).needsName, true)
        XCTAssertNil(try read(#"{"completed":true,"steps":{}}"#).needsName)
    }

    func testAComputersOnboardingHasNoCloudParts() throws {
        let json = #"{"completed":true,"steps":{"providers":{"done":true,"signedIn":true},"profile":"odd","project":{"done":false}}}"#
        let onboarding = try JSONDecoder().decode(Onboarding.self, from: Data(json.utf8))
        XCTAssertTrue(onboarding.completed)
        XCTAssertNil(onboarding.server)
        XCTAssertNil(onboarding.member)
        XCTAssertNil(onboarding.steps.chiefOfStaff)
        XCTAssertNil(onboarding.steps.profile)
        XCTAssertEqual(onboarding.steps.providers?.done, true)
    }

    func testOnboardingIsReadAgainOnConfigProviderAndProfileEvents() {
        XCTAssertEqual(Onboarding.refreshEvents, ["config.updated", "provider.", "profile."])
    }
}
