import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A working agent's `agent.updated`, laid over the bootstrap held instead
/// of reading it again: applied at the next version, ignored when already
/// held, and a read when a version was missed or the rows would move.
final class AgentUpdateTests: XCTestCase {
    private static let fixture = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],
     "projects":[{"id":"p","name":"happy","status":"active","orderKey":"a",
        "agents":[{"id":"root","workspaceId":"p","title":"Root chat","status":"idle","version":"0003"}]}],
     "workspaces":[],
     "bots":[{"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle","version":"0005","subtasks":[
        {"id":"sub","workspaceId":"r","parentAgentId":"research-agent","title":"Sub","status":"idle","version":"0002",
         "wait":{"startedAt":1,"dueAt":2}}]}}],
     "tasks":[{"id":"t1","name":"One","agent":{"id":"t1-agent","workspaceId":"t","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"}],
     "surfaces":[]}
    """#

    private func desktop() throws -> DesktopSnapshot {
        try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
    }

    private func update(_ id: String, from previous: String?, to version: String, _ changes: [String: JSONValue]) -> JSONValue {
        var payload: [String: JSONValue] = ["agentId": .string(id), "version": .string(version), "changes": .object(changes)]
        if let previous { payload["previousVersion"] = .string(previous) }
        return .object(payload)
    }

    private func agent(_ id: String, in desktop: DesktopSnapshot) -> AgentWire.Agent? {
        func find(_ agents: [AgentWire.Agent]) -> AgentWire.Agent? {
            for agent in agents {
                if agent.id == id { return agent }
                if let found = find(agent.subtasks ?? []) { return found }
            }
            return nil
        }
        return find(desktop.projects.flatMap(\.agents) + (desktop.bots ?? []).compactMap(\.agent) + (desktop.tasks ?? []).compactMap(\.agent))
    }

    func testTheNextVersionIsAppliedWhereverTheAgentIs() throws {
        let held = try desktop()
        guard case .applied(let next) = AgentUpdate.apply(update("sub", from: "0002", to: "0003", ["status": .string("working"), "wait": .null]), to: held) else {
            return XCTFail("not applied")
        }
        let sub = try XCTUnwrap(agent("sub", in: next))
        XCTAssertEqual(sub.status, "working")
        XCTAssertEqual(sub.version, "0003")
        XCTAssertNil(sub.wait)
        XCTAssertEqual(sub.title, "Sub")
        XCTAssertEqual(agent("root", in: next)?.status, "idle")

        guard case .applied(let root) = AgentUpdate.apply(update("root", from: "0003", to: "0004", ["title": .string("Renamed")]), to: next) else {
            return XCTFail("not applied")
        }
        XCTAssertEqual(agent("root", in: root)?.title, "Renamed")
        XCTAssertEqual(agent("sub", in: root)?.status, "working")
    }

    func testAVersionAlreadyHeldChangesNothing() throws {
        XCTAssertEqual(AgentUpdate.apply(update("root", from: "0002", to: "0003", ["status": .string("working")]), to: try desktop()), .unchanged)
        XCTAssertEqual(AgentUpdate.apply(update("nobody", from: "0001", to: "0002", ["status": .string("working")]), to: try desktop()), .unchanged)
    }

    func testAMissedVersionOrAMoveIsReadAgain() throws {
        let held = try desktop()
        XCTAssertEqual(AgentUpdate.apply(update("root", from: "0004", to: "0005", ["status": .string("working")]), to: held), .reread)
        XCTAssertEqual(AgentUpdate.apply(update("root", from: "0003", to: "0004", ["workspaceId": .string("elsewhere")]), to: held), .reread)
        XCTAssertEqual(AgentUpdate.apply(update("root", from: "0003", to: "0004", ["status": .number(1)]), to: held), .reread)
        // No version held to follow from.
        XCTAssertEqual(AgentUpdate.apply(update("t1-agent", from: nil, to: "0001", ["status": .string("working")]), to: held), .reread)
        XCTAssertEqual(AgentUpdate.apply(.object([:]), to: held), .reread)
    }

    /// A read that left before an update arrived doesn't roll it back.
    func testAReadKeepsWhatIsNewerHere() throws {
        let fetched = try desktop()
        guard case .applied(let held) = AgentUpdate.apply(update("sub", from: "0002", to: "0003", ["status": .string("working")]), to: fetched) else {
            return XCTFail("not applied")
        }
        let kept = AgentUpdate.keepingNewer(fetched, than: held)
        XCTAssertEqual(agent("sub", in: kept)?.status, "working")
        XCTAssertEqual(agent("sub", in: kept)?.version, "0003")
        XCTAssertEqual(AgentUpdate.keepingNewer(held, than: fetched), held)
    }

    /// Found by the index, an update does exactly what walking every agent
    /// does: the same outcome and the same bootstrap after it, whatever
    /// the update, over hundreds of them.
    func testFindingTheAgentByItsPlaceAgreesWithWalkingEveryAgent() throws {
        var walked = try desktop()
        var found = walked
        let index = AgentIndex(found)
        var versions = ["root": 3, "research-agent": 5, "sub": 2, "t1-agent": 0]
        var state: UInt64 = 0x2545F4914F6CDD1D
        func next(_ bound: Int) -> Int { state ^= state << 13; state ^= state >> 7; state ^= state << 17; return Int(state % UInt64(bound)) }
        let ids = ["root", "research-agent", "sub", "t1-agent", "nobody"]
        let changes: [[String: JSONValue]] = [
            ["status": .string("working")], ["status": .string("idle")], ["updatedAt": .number(5)], ["lastActivityAt": .number(70_000)],
            ["title": .string("Retitled")], ["unread": .object(["reason": .string("finished")])], ["unread": .null],
            ["wait": .null], ["pendingQuestionId": .string("q")], ["subagents": .object(["running": .number(2)])],
            ["workspaceId": .string("moved")], ["status": .number(1)],
        ]
        for step in 0..<400 {
            let id = ids[next(ids.count)]
            let held = versions[id] ?? 0
            // Mostly the next version; now and then one held already, or a gap.
            let offset = [1, 1, 1, 1, 0, 2][next(6)]
            let payload = update(id, from: String(format: "%04d", held), to: String(format: "%04d", held + offset), changes[next(changes.count)])
            let slow = AgentUpdate.apply(payload, to: walked)
            let fast = AgentUpdate.apply(payload, to: &found, index: index)
            switch (slow, fast) {
            case (.applied(let next), .applied):
                walked = next
                versions[id] = held + offset
            case (.unchanged, .unchanged), (.reread, .reread): break
            default: return XCTFail("step \(step): walking and the index disagree on \(id)")
            }
            XCTAssertEqual(found, walked, "step \(step)")
        }
    }

    /// The rows an update redraws (`SidebarRows.redraw`) are the rows home
    /// drawn whole after it would have, a muted bot's included; and an
    /// update that moves nothing a row draws redraws nothing.
    func testRedrawingAnAgentsRowsDrawsWhatDrawingHomeWholeDoes() throws {
        var held = try desktop()
        let settings: [String: JSONValue] = ["happy-desktop.bot.research": .object(["muted": .bool(true)])]
        let index = AgentIndex(held)
        var rows = SidebarRows.make(held, settings: settings)
        var versions = ["root": 3, "research-agent": 5, "sub": 2]
        func apply(_ id: String, _ change: [String: JSONValue]) -> [AgentUpdate.Patch] {
            let from = versions[id] ?? 0
            versions[id] = from + 1
            let payload = update(id, from: String(format: "%04d", from), to: String(format: "%04d", from + 1), change)
            guard case .applied(let patches) = AgentUpdate.apply(payload, to: &held, index: index) else { XCTFail("\(id) not applied"); return [] }
            return patches
        }
        let updates: [(String, [String: JSONValue])] = [
            ("sub", ["status": .string("working"), "wait": .null]), ("root", ["title": .string("Renamed")]),
            ("root", ["updatedAt": .number(1_000)]), ("root", ["updatedAt": .number(2_000)]), ("root", ["lastActivityAt": .number(61_000)]),
            ("research-agent", ["unread": .object(["reason": .string("finished")])]), ("root", ["unread": .object(["reason": .string("finished")])]),
            ("sub", ["pendingQuestionId": .string("q")]), ("root", ["status": .string("working")]),
        ]
        for (id, change) in updates {
            for patch in apply(id, change) {
                for (before, after) in zip(patch.before, patch.after) where SidebarRows.Drawn(before) != SidebarRows.Drawn(after) {
                    for row in rows.indices where SidebarRows.drawsAgent(rows[row]) && rows[row].agentId == after.id {
                        SidebarRows.redraw(&rows[row], for: after)
                    }
                }
            }
            XCTAssertEqual(rows, SidebarRows.make(held, settings: settings), "after \(id) \(change)")
        }
        // A word's update, its time within the minute: nothing a row draws moves.
        let quiet = apply("root", ["updatedAt": .number(2_500)])
        XCTAssertFalse(quiet.isEmpty)
        XCTAssertTrue(quiet.allSatisfy { zip($0.before, $0.after).allSatisfy { SidebarRows.Drawn($0) == SidebarRows.Drawn($1) } })
    }
}
