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
}
