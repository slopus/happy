import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A Happy Cloud server's Chief of Staff: known by its `systemKey` alone,
/// and never archived.
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
}
