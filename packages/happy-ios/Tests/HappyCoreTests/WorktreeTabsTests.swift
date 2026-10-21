import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Cases after happy-app's utils/worktreeTabs.test.ts, and the checkout
/// lookup behind useProjectWorktree.ts.
final class WorktreeTabsTests: XCTestCase {
    private func tab(_ id: String, createdAt: Int64 = 0) -> WorktreeTab {
        WorktreeTab(id: id, title: nil, state: .waiting, unread: false, createdAt: createdAt)
    }

    private func chat(_ id: String, sessionId: String? = nil, known: [String] = ["anchor"], createdAt: Int64 = 0, status: PendingChat.Status = .starting) -> PendingChat {
        PendingChat(id: id, anchorSessionId: "anchor", sessionId: sessionId, knownSessionIds: known, status: status, draft: "", queued: [], createdAt: createdAt)
    }

    private func ids(_ tabs: [WorktreeTab]) -> [String] { tabs.map(\.id) }

    // MARK: neighbouringTabId

    func testTheTabOnTheLeftTakesOver() {
        let tabs = [tab("first"), tab("middle"), tab("last")]
        XCTAssertEqual(WorktreeTabs.neighbour(of: "last", in: tabs), "middle")
        XCTAssertEqual(WorktreeTabs.neighbour(of: "middle", in: tabs), "first")
        // Nothing to the left: the right.
        XCTAssertEqual(WorktreeTabs.neighbour(of: "first", in: tabs), "middle")
        XCTAssertNil(WorktreeTabs.neighbour(of: "only", in: [tab("only")]))
        XCTAssertNil(WorktreeTabs.neighbour(of: "elsewhere", in: tabs))
    }

    // MARK: resolveWorktreeTabs

    func testACheckoutWithNothingBeingStartedIsLeftAlone() {
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor"), tab("other")], pending: [])
        XCTAssertEqual(ids(resolved.tabs), ["anchor", "other"])
        XCTAssertEqual(resolved.pending, [])
    }

    func testTheStandInIsDrawnWhileItsSessionIsUnnamed() {
        let opening = chat("pending-1")
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor")], pending: [opening])
        XCTAssertEqual(ids(resolved.tabs), ["anchor"])
        XCTAssertEqual(resolved.pending, [opening])
    }

    func testTheArrivalItsStandInStandsForWaits() {
        // The session reached the list before the request that made it came
        // back with its name.
        let opening = chat("pending-1")
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor"), tab("arrival")], pending: [opening])
        XCTAssertEqual(ids(resolved.tabs), ["anchor"])
        XCTAssertEqual(resolved.pending, [opening])
    }

    func testANamedStandInHandsTheTabOver() {
        let named = chat("pending-1", sessionId: "arrival")
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor"), tab("arrival"), tab("elsewhere")], pending: [named])
        XCTAssertEqual(ids(resolved.tabs), ["anchor", "arrival", "elsewhere"])
        XCTAssertEqual(resolved.pending, [])
    }

    func testANamedStandInDoesNotComeBackForAnArchivedChat() {
        let named = chat("pending-1", sessionId: "archived")
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor")], pending: [named])
        XCTAssertEqual(ids(resolved.tabs), ["anchor"])
        XCTAssertEqual(resolved.pending, [])
    }

    func testConcurrentStartsTakeAnArrivalEachInTheOrderAsked() {
        let first = chat("pending-1", createdAt: 1)
        let second = chat("pending-2", createdAt: 2)
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor"), tab("arrival-1"), tab("arrival-2")], pending: [first, second])
        XCTAssertEqual(ids(resolved.tabs), ["anchor"])
        XCTAssertEqual(resolved.pending, [first, second])
    }

    func testOneArrivalIsHeldBackPerStartNotEveryNewcomer() {
        let resolved = WorktreeTabs.resolve(tabs: [tab("anchor"), tab("arrival"), tab("elsewhere")], pending: [chat("pending-1")])
        XCTAssertEqual(ids(resolved.tabs), ["anchor", "elsewhere"])
    }

    func testOnlyStartsBesideTheCheckoutCountOldestFirst() {
        var other = chat("pending-3", createdAt: 0)
        other.anchorSessionId = "somewhere-else"
        let chats = [
            "pending-2": chat("pending-2", createdAt: 2),
            "pending-1": chat("pending-1", createdAt: 1),
            "pending-3": other,
            "failed": chat("failed", createdAt: 0, status: .failed),
        ]
        XCTAssertEqual(WorktreeTabs.pendingBeside(chats, tabIds: ["anchor"]).map(\.id), ["pending-1", "pending-2"])
    }

    func testTabsRunOldestFirst() {
        let tabs = WorktreeTabs.tabOrder([tab("c", createdAt: 3), tab("b", createdAt: 1), tab("a", createdAt: 1)])
        XCTAssertEqual(ids(tabs), ["a", "b", "c"])
    }

    // MARK: The checkout

    private func record(
        _ id: String,
        machine: String = "m1",
        path: String? = nil,
        createdAt: Int64 = 1,
        active: Bool = true,
        rig: Bool = false,
        project: (id: String, name: String)? = nil,
        workspace: (id: String, name: String)? = nil,
        summary: String? = nil,
        extra: [String: JSONValue] = [:]
    ) -> SessionRecord {
        var metadata = extra
        metadata["machineId"] = .string(machine)
        metadata["lastMeaningfulMessageAt"] = .number(Double(createdAt))
        if let path { metadata["path"] = .string(path) }
        if rig { metadata["client"] = .object(["id": .string("rig")]) }
        if let project { metadata["project"] = .object(["id": .string(project.id), "name": .string(project.name)]) }
        if let workspace { metadata["workspace"] = .object(["id": .string(workspace.id), "name": .string(workspace.name)]) }
        if let summary { metadata["summary"] = .object(["text": .string(summary)]) }
        return SessionRecord(
            id: id, seq: 0, createdAt: createdAt, updatedAt: 1, active: active, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
    }

    private func snapshot(_ sessions: [SessionRecord]) -> HomeSnapshot {
        HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: []), sessions: sessions)
    }

    func testAPathCheckoutHoldsItsChatsOldestFirst() {
        let home = snapshot([
            record("newer", path: "/src/happy", createdAt: 30, summary: "Fix the strip"),
            record("older", path: "/src/happy", createdAt: 10),
            record("worktree", path: "/src/happy/.dev/worktree/gdansk", createdAt: 20),
            record("elsewhere", machine: "m2", path: "/src/happy", createdAt: 5),
        ])
        let checkout = WorktreeCheckout.locate("newer", in: home)
        XCTAssertEqual(checkout?.projectName, "happy")
        XCTAssertNil(checkout?.workspaceName, "the project's own checkout goes by its branch")
        XCTAssertEqual(checkout?.tabs.map(\.id), ["older", "newer"])
        XCTAssertEqual(checkout?.tabs.last?.title, "Fix the strip")
        XCTAssertEqual(checkout?.id, "happy:[\"m1\",\"/src/happy\"]\u{0}")
    }

    func testAWorktreeIsItsOwnCheckoutNamedForItsFolder() {
        let home = snapshot([
            record("own", path: "/src/happy", createdAt: 1),
            record("a", path: "/src/happy/.dev/worktree/gdansk", createdAt: 2),
            record("b", path: "/src/happy/.dev/worktree/gdansk", createdAt: 3),
        ])
        let checkout = WorktreeCheckout.locate("b", in: home)
        XCTAssertEqual(checkout?.workspaceName, "gdansk")
        XCTAssertEqual(checkout?.projectName, "happy")
        XCTAssertEqual(checkout?.tabs.map(\.id), ["a", "b"])
    }

    func testAHappyAgentWorkspaceGoesByItsCatalogName() {
        let project = (id: "p1", name: "Happy")
        let home = snapshot([
            record("main", rig: true, project: project, workspace: nil),
            record("ws-1", rig: true, project: project, workspace: (id: "w1", name: "Strip work"), extra: [:]),
            record("ws-2", createdAt: 2, rig: true, project: project, workspace: (id: "w1", name: "Strip work")),
        ])
        let checkout = WorktreeCheckout.locate("ws-1", in: home)
        XCTAssertEqual(checkout?.projectName, "Happy")
        XCTAssertEqual(checkout?.workspaceName, "Strip work")
        XCTAssertEqual(checkout?.tabs.map(\.id), ["ws-1", "ws-2"])
        XCTAssertEqual(checkout?.id, "p1\u{0}w1")
    }

    func testAHappyAgentChatAndAHappyChatInOneFolderAreTwoProjects() {
        let home = snapshot([
            record("happy", path: "/src/happy", createdAt: 1),
            record("rig", path: "/src/happy", createdAt: 2, rig: true),
            record("padded", path: " /src/happy\n", createdAt: 3),
        ])
        XCTAssertEqual(WorktreeCheckout.locate("happy", in: home)?.tabs.map(\.id), ["happy", "padded"])
        let rig = WorktreeCheckout.locate("rig", in: home)
        XCTAssertEqual(rig?.tabs.map(\.id), ["rig"])
        XCTAssertEqual(rig?.id, "rig:[\"m1\",\"/src/happy\"]\u{0}")
    }

    func testTheProjectIsNamedByItsLiveChatAndTheCheckoutByItsOwn() {
        let project = (id: "p1", name: "Happy")
        let home = snapshot([
            record("stale", createdAt: 1, rig: true, project: (id: "p1", name: "Old name"), workspace: (id: "w1", name: "Old workspace")),
            record("live", createdAt: 5, rig: true, project: project, workspace: (id: "w2", name: "Other")),
            record("tab", createdAt: 3, rig: true, project: project, workspace: (id: "w1", name: "Strip work")),
        ])
        let checkout = WorktreeCheckout.locate("tab", in: home)
        XCTAssertEqual(checkout?.projectName, "Happy", "the project's first chat in list order names it")
        XCTAssertEqual(checkout?.workspaceName, "Strip work", "the checkout's own first chat names it")
        XCTAssertEqual(checkout?.tabs.map(\.id), ["stale", "tab"])
    }

    func testBotsSideChatsAndTheArchiveAreInNoCheckout() {
        // A Happy CLI chat that has stopped is in the archive.
        let archived = record("archived", path: "/src/happy", active: false)
        let home = snapshot([
            record("bot", path: "/src/happy", extra: ["bot": .object(["id": .string("b"), "name": .string("Bot")])]),
            record("side", path: "/src/happy", extra: ["isSideChat": .bool(true)]),
            archived,
            record("chat", path: "/src/happy", createdAt: 2),
        ])
        XCTAssertNil(WorktreeCheckout.locate("bot", in: home))
        XCTAssertNil(WorktreeCheckout.locate("side", in: home))
        XCTAssertNil(WorktreeCheckout.locate("missing", in: home))
        XCTAssertEqual(WorktreeCheckout.locate("chat", in: home)?.tabs.map(\.id), ["chat"])
    }

    func testATabSaysWhetherItsAgentWorksOrWaitsOnThePerson() {
        var working = record("working", path: "/src/happy")
        working.thinking = true
        var blocked = record("blocked", path: "/src/happy", createdAt: 2)
        blocked.agentState = .object(["requests": .object(["r1": .object([:])])])
        var unread = record("unread", path: "/src/happy", createdAt: 3)
        unread.unread = true
        let tabs = WorktreeCheckout.locate("working", in: snapshot([working, blocked, unread]))?.tabs ?? []
        XCTAssertEqual(tabs.map(\.working), [true, false, false])
        XCTAssertEqual(tabs.map(\.blocked), [false, true, false])
        XCTAssertEqual(tabs.map(\.unread), [false, false, true])
    }
}
