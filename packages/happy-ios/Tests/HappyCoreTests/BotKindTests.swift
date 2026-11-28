import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A Happy Cloud server's bots carry a `kind`: the shared one, which only
/// owners receive, closes home's first group, after Activity, Artifacts
/// and the rest, as desktop orders it;
/// personal ones stay among the bots, each opening the reader's own
/// conversation. Where a bot goes is its kind's alone, never `isAdmin`
/// or `systemKey`, and a daemon's bots, which carry no kind, are listed
/// as they always were.
final class BotKindTests: XCTestCase {
    // MARK: Decoding

    func testABotDecodesItsKindEditabilityInstructionsAndRevision() throws {
        let json = #"""
        {"id":"helper","name":"Release helper","isAdmin":false,"systemKey":null,"status":"active","avatar":null,
         "kind":"personal","editable":true,"instructions":"Ship on Fridays.","revision":3,"version":"v7",
         "agent":{"id":"helper-mine","workspaceId":"w","status":"idle"}}
        """#
        let bot = try JSONDecoder().decode(AgentWire.Bot.self, from: Data(json.utf8))
        XCTAssertEqual(bot.kind, "personal")
        XCTAssertEqual(bot.botKind, .personal)
        XCTAssertEqual(bot.isAdmin, false)
        XCTAssertEqual(bot.editable, true)
        XCTAssertEqual(bot.instructions, "Ship on Fridays.")
        XCTAssertEqual(bot.revision, 3)
        XCTAssertEqual(bot.version, "v7")
        XCTAssertEqual(bot.agent?.id, "helper-mine", "a personal bot's agent is the reader's own")
    }

    /// A daemon's bot has none of them, and reads as before.
    func testADaemonsBotHasNoKind() throws {
        let json = #"{"id":"research","name":"Research","status":"active","agent":{"id":"a","workspaceId":"w","status":"idle"}}"#
        let bot = try JSONDecoder().decode(AgentWire.Bot.self, from: Data(json.utf8))
        XCTAssertNil(bot.kind)
        XCTAssertNil(bot.botKind)
        XCTAssertNil(bot.editable)
        XCTAssertNil(bot.instructions)
        XCTAssertNil(bot.revision)
    }

    /// A field this build can't read is none, never a lost bot; a kind it
    /// doesn't know is drawn as a personal one.
    func testFieldsItCantReadAreNoneAndAnUnknownKindIsPersonal() throws {
        let json = #"{"id":"b","name":"B","kind":"team","editable":"yes","instructions":7,"revision":"3","isAdmin":"no"}"#
        let bot = try JSONDecoder().decode(AgentWire.Bot.self, from: Data(json.utf8))
        XCTAssertEqual(bot.botKind, .personal)
        XCTAssertNil(bot.editable)
        XCTAssertNil(bot.instructions)
        XCTAssertNil(bot.revision)
        XCTAssertNil(bot.isAdmin)
        let bad = #"{"cursor":"c","profile":{"userId":"u"},"userSettings":[],"projects":[],"workspaces":[],"bots":[{"id":"b","name":"B","kind":5,"editable":"yes","agent":{"id":"a","workspaceId":"w","status":"idle"}}]}"#
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(bad.utf8))
        XCTAssertEqual(desktop.bots?.first?.id, "b", "a bad kind lost the bootstrap")
        XCTAssertNil(desktop.bots?.first?.kind)
        XCTAssertNil(desktop.bots?.first?.editable)
    }

    /// Any kind may be admin or not: both pairs the server may send decode.
    func testKindAndAdminAreIndependent() throws {
        for (kind, admin) in [("shared", true), ("shared", false), ("personal", true), ("personal", false)] {
            let json = #"{"id":"b","name":"B","kind":"\#(kind)","isAdmin":\#(admin)}"#
            let bot = try JSONDecoder().decode(AgentWire.Bot.self, from: Data(json.utf8))
            XCTAssertEqual(bot.kind, kind)
            XCTAssertEqual(bot.isAdmin, admin)
        }
    }

    // MARK: Sectioning

    private static func bootstrap(bots: String) -> String {
        #"""
        {"cursor":"c1","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],
         "bots":[\#(bots)],
         "tasks":[{"id":"t1","name":"One","agent":{"id":"t1-agent","workspaceId":"t","status":"idle"}}],
         "taskMemberships":[{"taskId":"t1","orderKey":"a"}],"surfaces":[]}
        """#
    }

    private static let chief = #"{"id":"cos","name":"Chief of Staff","systemKey":"chief_of_staff","isAdmin":true,"kind":"shared","editable":false,"status":"active","agent":{"id":"cos-agent","workspaceId":"cw","status":"idle","subtasks":[{"id":"cos-sub","workspaceId":"cw","parentAgentId":"cos-agent","title":"Hiring","status":"idle"}]}}"#
    private static let helper = #"{"id":"helper","name":"Release helper","isAdmin":false,"kind":"personal","editable":true,"revision":2,"status":"active","agent":{"id":"helper-mine","workspaceId":"hw","status":"idle"}}"#
    private static let notes = #"{"id":"notes","name":"Notes","isAdmin":false,"kind":"personal","editable":false,"status":"active","agent":{"id":"notes-mine","workspaceId":"nw","status":"idle"}}"#

    private func rows(_ bots: String, settings: [String: JSONValue] = [:]) throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.bootstrap(bots: bots).utf8))
        return SidebarRows.make(desktop, settings: settings, feed: .init(unread: 0))
    }

    /// An owner: the shared bot (and its subtask) closes the first group,
    /// after Activity, Artifacts, Documents and TODOs; the personal bots are the bots.
    func testAnOwnerSeesTheSharedBotInTheMainGroup() throws {
        let rows = try rows([Self.chief, Self.helper, Self.notes].joined(separator: ","))
        XCTAssertEqual(rows.map(\.id), [
            "direct:feed", "direct:artifacts", "direct:documents", "direct:todos", "bot:cos", "session:cos-sub",
            "direct:bots", "bot:helper", "bot:notes",
            "direct:tasks", "task:t1",
            "direct:projects",
        ])
        let shared = try XCTUnwrap(rows.first { $0.id == "bot:cos" })
        XCTAssertTrue(shared.sharedBot)
        XCTAssertFalse(shared.editable)
        XCTAssertEqual(shared.agentId, "cos-agent")
        XCTAssertEqual(shared.targetKind, "bot")
        XCTAssertEqual(shared.targetId, "cos")
        XCTAssertFalse(SidebarReorder.movable(shared), "the shared bot moved among the bots")
        let helper = try XCTUnwrap(rows.first { $0.id == "bot:helper" })
        XCTAssertFalse(helper.sharedBot)
        XCTAssertTrue(helper.editable)
        XCTAssertEqual(helper.agentId, "helper-mine")
        XCTAssertTrue(SidebarReorder.movable(helper))
        XCTAssertFalse(try XCTUnwrap(rows.first { $0.id == "bot:notes" }).editable)
        // The bots move among themselves only.
        XCTAssertEqual(SidebarReorder.family(rows, at: rows.firstIndex { $0.id == "bot:helper" }!)?.count, 2)
    }

    /// A member is never sent the shared bot: the first group is Activity,
    /// Artifacts and Todos, and the personal bots open their own conversations.
    func testAMemberSeesOnlyPersonalBots() throws {
        let rows = try rows([Self.helper, Self.notes].joined(separator: ","))
        XCTAssertEqual(Array(rows.map(\.id).prefix(5)), ["direct:feed", "direct:artifacts", "direct:documents", "direct:todos", "direct:bots"])
        XCTAssertEqual(rows.filter { $0.targetKind == "bot" }.map(\.agentId), ["helper-mine", "notes-mine"])
        XCTAssertFalse(rows.contains { $0.sharedBot })
    }

    /// Placed by kind, never by `isAdmin` or `systemKey`: a shared bot that
    /// isn't admin closes the first group; an admin personal one stays a bot.
    func testPlacementGoesByKindAlone() throws {
        let sharedPlain = #"{"id":"desk","name":"Front desk","isAdmin":false,"kind":"shared","status":"active","agent":{"id":"desk-agent","workspaceId":"d","status":"idle"}}"#
        let personalAdmin = #"{"id":"ops","name":"Ops","isAdmin":true,"systemKey":"chief_of_staff","kind":"personal","editable":true,"status":"active","agent":{"id":"ops-mine","workspaceId":"o","status":"idle"}}"#
        let rows = try rows([sharedPlain, personalAdmin].joined(separator: ","))
        let bots = try XCTUnwrap(rows.firstIndex { $0.id == "direct:bots" })
        XCTAssertEqual(rows[bots - 1].id, "bot:desk")
        XCTAssertTrue(rows[bots - 1].sharedBot)
        XCTAssertEqual(rows[bots + 1].id, "bot:ops")
        XCTAssertTrue(rows[bots + 1].editable)
    }

    /// A shared bot is a destination of its own: a setting desktop hid
    /// bots with doesn't take it away. A personal one hides as before.
    func testHidingTakesOnlyPersonalBots() throws {
        let hidden: [String: JSONValue] = [
            "happy-desktop.bot.cos": .object(["hidden": .bool(true)]),
            "happy-desktop.bot.helper": .object(["hidden": .bool(true)]),
        ]
        let rows = try rows([Self.chief, Self.helper].joined(separator: ","), settings: hidden)
        XCTAssertTrue(rows.contains { $0.id == "bot:cos" })
        XCTAssertFalse(rows.contains { $0.id == "bot:helper" })
    }

    /// A daemon's bots carry no kind: listed after the separator, as they
    /// always were, the Chief of Staff among them; none is shared or editable.
    func testADaemonsBotsAreListedAsBefore() throws {
        let legacyChief = #"{"id":"cos","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"cos-agent","workspaceId":"cw","status":"idle"}}"#
        let legacy = #"{"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}"#
        let rows = try rows([legacyChief, legacy].joined(separator: ","))
        XCTAssertEqual(Array(rows.map(\.id).prefix(7)), ["direct:feed", "direct:artifacts", "direct:documents", "direct:todos", "direct:bots", "bot:cos", "bot:research"])
        XCTAssertFalse(rows.contains { $0.sharedBot || $0.editable })
        XCTAssertTrue(try XCTUnwrap(rows.first { $0.id == "bot:cos" }).isHappy)
    }
}
