import Foundation
@testable import HappyCore
import XCTest

/// A chat's profile wears the avatar its home row does: it finds that row
/// among home's own rows and takes its mark, so the placeholder is the
/// same one (its seed is the row's: the bot's or task's ID, not the
/// agent's). Without a mark or a row, the agent's ID picks it.
final class ProfileMarkTests: XCTestCase {
    private let rows = [
        Row(id: "direct:bots", nodeId: "direct:bots", kind: .separator, label: ""),
        Row(id: "bot:b1", nodeId: "bot:b1", kind: .space, label: "Research", mark: .placeholder(seed: "b1"), agentId: "agent-1", targetKind: "bot"),
        Row(id: "task:t1", nodeId: "task:t1", kind: .space, label: "Poem", mark: .image(path: "/v0/x", thumbhash: "h"), agentId: "agent-2", targetKind: "task"),
        Row(id: "session:agent-3", nodeId: "session:agent-3", kind: .session, depth: 1, label: "A session", agentId: "agent-3"),
        Row(id: "surface:s1", nodeId: "surface:s1", kind: .space, label: "Doc", mark: .glyph("doc"), agentId: "agent-4", targetKind: "surface"),
    ]

    func testTheProfileFindsItsHomeRowAndWearsItsMark() throws {
        let research = try XCTUnwrap(SidebarRows.row(agentId: "agent-1", spaceId: nil, in: rows))
        XCTAssertEqual(research.id, "bot:b1")
        XCTAssertEqual(SidebarRows.profileMark(research, agentId: "agent-1"), .placeholder(seed: "b1"))
        // The bot's ID picks it, as on home: not the agent's.
        XCTAssertNotEqual(SidebarRows.profileMark(research, agentId: "agent-1"), .placeholder(seed: "agent-1"))
        let poem = SidebarRows.row(agentId: "agent-2", spaceId: nil, in: rows)
        XCTAssertEqual(SidebarRows.profileMark(poem, agentId: "agent-2"), .image(path: "/v0/x", thumbhash: "h"))
    }

    func testAMarklessRowOrNoneIsTheAgentsPlaceholder() {
        let session = SidebarRows.row(agentId: "agent-3", spaceId: nil, in: rows)
        XCTAssertEqual(session?.mark, Row.Mark.none)
        XCTAssertEqual(SidebarRows.profileMark(session, agentId: "agent-3"), .placeholder(seed: "agent-3"))
        XCTAssertNil(SidebarRows.row(agentId: "agent-9", spaceId: nil, in: rows))
        XCTAssertEqual(SidebarRows.profileMark(nil, agentId: "agent-9"), .placeholder(seed: "agent-9"))
        // Never the glyph tile the profile used to fall back on.
        XCTAssertNotEqual(SidebarRows.profileMark(nil, agentId: "agent-9"), .glyph("agents"))
    }

    func testASpacesRowIsFoundByItsSpace() {
        var space = Row(id: "space:sp", nodeId: "n", kind: .space, label: "Space", mark: .clay("fox"), agentId: "agent-1", spaceId: "sp")
        space.targetKind = "task"
        let found = SidebarRows.row(agentId: "agent-1", spaceId: "sp", in: rows + [space])
        XCTAssertEqual(found?.id, "space:sp")
    }

    /// Home's rows as `SidebarRows.make` draws them: the profile of a bot's
    /// chat finds the bot's row and its placeholder.
    func testHomesOwnRowsGiveTheBotsPlaceholder() throws {
        let made = SidebarRows.make(Self.desktop, settings: [:])
        let row = try XCTUnwrap(SidebarRows.row(agentId: "agent-bot", spaceId: nil, in: made))
        XCTAssertEqual(SidebarRows.profileMark(row, agentId: "agent-bot"), .placeholder(seed: "bot-1"))
    }

    private static let desktop: DesktopSnapshot = {
        let json = #"""
        {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
         "bots":[{"id":"bot-1","name":"Research","status":"active","agent":{"id":"agent-bot","workspaceId":"r","status":"idle"}}],
         "surfaces":[]}
        """#
        return try! JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
    }()
}
