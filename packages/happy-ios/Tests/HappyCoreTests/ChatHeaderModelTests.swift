import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class ChatHeaderModelTests: XCTestCase {
    private func session(active: Bool = true, metadata: JSONValue?) -> SessionRecord {
        SessionRecord(
            id: "s", seq: 1, createdAt: 1, updatedAt: 1, active: active, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: metadata,
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func status(branch: String?, added: Int, removed: Int) -> GitStatus {
        var status = GitStatus(lastUpdatedAt: 1)
        status.branch = branch
        status.unstagedFiles = [GitFileStatus(fileName: "a", filePath: "", fullPath: "a", status: .modified, isStaged: false, linesAdded: added, linesRemoved: removed)]
        return status
    }

    func testNothingUntilSessionsHaveBeenFetchedThenDeletedIfAbsent() {
        XCTAssertEqual(ChatHeaderModel(session: nil, dataReady: false, gitStatus: nil).title, .loading)
        XCTAssertEqual(ChatHeaderModel(session: session(metadata: nil), dataReady: false, gitStatus: nil).title, .loading)
        let deleted = ChatHeaderModel(session: nil, dataReady: true, gitStatus: status(branch: "main", added: 1, removed: 0))
        XCTAssertEqual(deleted.title, .deleted)
        XCTAssertNil(deleted.subtitle)
        XCTAssertNil(deleted.changes)
        // A chat on its way to a machine is "New chat", never deleted.
        XCTAssertEqual(ChatHeaderModel(session: nil, dataReady: true, gitStatus: nil, pending: true).title, .name(nil))
        XCTAssertEqual(ChatHeaderModel(session: nil, dataReady: false, gitStatus: nil, pending: true).title, .loading)
    }

    func testTheNameTheBranchAndTheLineChanges() {
        let model = ChatHeaderModel(
            session: session(active: false, metadata: ["summary": ["text": "Fix login"], "gitBranch": "started-here"]),
            dataReady: true,
            gitStatus: status(branch: " feature/x ", added: 12, removed: 3)
        )
        XCTAssertEqual(model.title, .name("Fix login"))
        XCTAssertEqual(model.subtitle, "feature/x", "the live branch, trimmed, over the one it started on")
        XCTAssertEqual(model.changes, SessionDetails.LineChanges(insertions: 12, deletions: 3, approximate: false))
        XCTAssertFalse(model.connected)

        let unnamed = ChatHeaderModel(session: session(metadata: ["gitBranch": "started-here"]), dataReady: true, gitStatus: nil)
        XCTAssertEqual(unnamed.title, .name(nil))
        XCTAssertEqual(unnamed.subtitle, "started-here")
        XCTAssertNil(unnamed.changes)
        XCTAssertTrue(unnamed.connected)
    }

    func testAWorkspaceIsNamedBeforeItsBranch() {
        let metadata: JSONValue = ["workspace": ["name": " ios-chat "], "gitBranch": "worktree/ios-chat"]
        XCTAssertEqual(ChatHeaderModel.subtitle(metadata, gitStatus: status(branch: "main", added: 0, removed: 0)), "ios-chat")
        XCTAssertNil(ChatHeaderModel.subtitle(["workspace": ["name": "  "]], gitStatus: nil))
    }

    func testAHappyAgentSessionShowsItsPublishedComparison() {
        let metadata: JSONValue = ["client": ["id": "rig"], "git": ["insertions": 1200, "deletions": 0, "changedFiles": 4]]
        let model = ChatHeaderModel(session: session(metadata: metadata), dataReady: true, gitStatus: status(branch: "main", added: 5, removed: 5))
        XCTAssertEqual(model.changes, SessionDetails.LineChanges(insertions: 1200, deletions: 0, approximate: true))
    }
}

final class ChatEmptyStateTests: XCTestCase {
    func testTheMachinesOS() {
        XCTAssertEqual(ChatEmptyState.osIcon("darwin"), "laptop-outline", "darwin contains \"win\" but is checked first")
        XCTAssertEqual(ChatEmptyState.osIcon("MacOS"), "laptop-outline")
        XCTAssertEqual(ChatEmptyState.osIcon("win32"), "desktop-outline")
        XCTAssertEqual(ChatEmptyState.osIcon("linux"), "terminal-outline")
        XCTAssertEqual(ChatEmptyState.osIcon("freebsd"), "hardware-chip-outline")
        XCTAssertEqual(ChatEmptyState.osIcon(nil), "hardware-chip-outline")
        XCTAssertEqual(ChatEmptyState.osIcon(""), "hardware-chip-outline")
    }

    func testTheHostTheFolderAndWhenItWasCreated() {
        let metadata: JSONValue = ["host": "studio", "path": "/Users/kirill/happy", "homeDir": "/Users/kirill", "os": "darwin"]
        let state = ChatEmptyState(metadata: metadata, createdAt: 0, now: 3 * 3_600_000 + 59_000)
        XCTAssertEqual(state.osIcon, "laptop-outline")
        XCTAssertEqual(state.host, "studio")
        XCTAssertEqual(state.path, "~/happy")
        XCTAssertEqual(state.created, .hours(3))

        let bare = ChatEmptyState(metadata: ["host": "", "path": ""], createdAt: 1_000, now: 1_000 + 59_999)
        XCTAssertNil(bare.host)
        XCTAssertNil(bare.path)
        XCTAssertEqual(bare.created, .justNow)
        XCTAssertEqual(ChatEmptyState(metadata: nil, createdAt: 0, now: 2 * 86_400_000).created, .days(2))
    }
}

final class CliVersionWarningTests: XCTestCase {
    func testAnOldCliWarnsUntilItsVersionIsDismissedOnThatMachine() {
        let old: JSONValue = ["version": "0.9.4", "machineId": "m1"]
        let warning = CliVersionWarning(metadata: old, acknowledged: [:])
        XCTAssertEqual(warning, CliVersionWarning(metadata: old, acknowledged: ["m1": "0.9.3"]), "an older dismissal")
        let dismissed = warning?.dismissed(in: ["m2": "0.8.0"])
        XCTAssertEqual(dismissed, ["m1": "0.9.4", "m2": "0.8.0"])
        XCTAssertNil(CliVersionWarning(metadata: old, acknowledged: dismissed ?? [:]))
        XCTAssertNil(CliVersionWarning(metadata: ["version": "0.10.0", "machineId": "m1"], acknowledged: [:]))
        XCTAssertNil(CliVersionWarning(metadata: ["machineId": "m1"], acknowledged: [:]), "no version")
        XCTAssertNil(CliVersionWarning(metadata: ["version": "0.9.4"], acknowledged: [:])?.dismissed(in: [:]), "no machine to keep it for")
    }
}

final class PendingChatPlaceholderTests: XCTestCase {
    func testQueuedMessagesComeBeforeTheAnchorsFolder() {
        let anchor: JSONValue = ["path": "/Users/a/repo", "homeDir": "/Users/a"]
        XCTAssertEqual(PendingChatPlaceholderModel(queued: ["one", "two"], anchorMetadata: anchor).detail, .queued("one\n\ntwo"))
        XCTAssertEqual(PendingChatPlaceholderModel(queued: [], anchorMetadata: anchor).detail, .path("~/repo"))
        XCTAssertNil(PendingChatPlaceholderModel(queued: [], anchorMetadata: ["path": ""]).detail)
        XCTAssertNil(PendingChatPlaceholderModel(queued: [], anchorMetadata: nil).detail, "the anchor isn't loaded")
    }
}

final class InactiveSessionHintTests: XCTestCase {
    private func session(active: Bool = false, metadata: JSONValue) -> SessionRecord {
        SessionRecord(
            id: "s", seq: 1, createdAt: 1, updatedAt: 1, active: active, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: metadata,
            agentStateVersion: 1, agentStateCipher: nil, agentState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func machine(active: Bool) -> MachineRecord {
        MachineRecord(
            id: "m1", seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: ["resumeSupport": ["rpcAvailable": .bool(true)]],
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private let claude: JSONValue = ["machineId": "m1", "claudeSessionId": "c-1", "path": "/Users/a/repo"]

    func testAnInactiveSessionOffersResumeWhenItsMachineCanRunIt() {
        XCTAssertEqual(InactiveSessionHint(session: session(metadata: claude), machine: machine(active: true))?.action, .resume)
        XCTAssertNil(InactiveSessionHint(session: session(active: true, metadata: claude), machine: machine(active: true)), "connected")
        XCTAssertNil(InactiveSessionHint(session: nil, machine: nil), "a chat that doesn't exist yet")
        XCTAssertNil(InactiveSessionHint(session: session(metadata: ["client": ["id": "rig"]]), machine: nil), "Happy Agent")
    }

    func testOtherwiseItShowsTheTerminalCommands() {
        let offline = InactiveSessionHint(session: session(metadata: claude), machine: machine(active: false))
        XCTAssertEqual(offline?.action, .command(lines: ["cd '/Users/a/repo'", "happy claude --resume c-1"]))
        XCTAssertEqual(offline?.copyText, "cd '/Users/a/repo'\nhappy claude --resume c-1")
        XCTAssertEqual(InactiveSessionHint(session: session(metadata: ["machineId": "m1"]), machine: nil)?.action, .noticeOnly, "nothing to resume with")
    }
}

final class ChatDockBarsTests: XCTestCase {
    private func session(active: Bool = true, metadata: JSONValue?, goal: JSONValue?) -> SessionRecord {
        SessionRecord(
            id: "s", seq: 1, createdAt: 1, updatedAt: 1, active: active, activeAt: 1, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: metadata,
            agentStateVersion: 1, agentStateCipher: nil, agentState: goal.map { ["agentGoalStatus": $0] }, dataKeyCipher: "k", decryptable: true
        )
    }

    private let goal: JSONValue = [
        "status": "active", "source": "codex", "text": "  review the branch ", "sourceSessionId": "thread-1", "observedAt": 1,
        "capabilities": ["clear": .bool(true), "stop": .bool(true), "edit": .bool(false)],
    ]

    func testAnActiveGoalFromThisRunWhileOnline() {
        let shown = VisibleAgentGoal(session(metadata: ["codexThreadId": "thread-1"], goal: goal))
        XCTAssertEqual(shown?.text, "review the branch")
        XCTAssertEqual(shown?.actions, [.stop, .clear], "edit, stop, clear, for the capabilities reported")

        XCTAssertNil(VisibleAgentGoal(session(active: false, metadata: ["codexThreadId": "thread-1"], goal: goal)), "offline")
        XCTAssertNil(VisibleAgentGoal(session(metadata: ["codexThreadId": "thread-2"], goal: goal)), "another run's goal")
        XCTAssertNil(VisibleAgentGoal(session(metadata: ["claudeSessionId": "thread-1"], goal: goal)), "the source names which id")
        XCTAssertNil(VisibleAgentGoal(session(metadata: ["codexThreadId": "thread-1"], goal: ["status": "inactive", "source": "codex", "sourceSessionId": "thread-1", "observedAt": 1])))
        XCTAssertNil(VisibleAgentGoal(session(metadata: ["claudeSessionId": "c"], goal: ["status": "active", "source": "claude", "text": "   ", "sourceSessionId": "c", "observedAt": 1])))
        XCTAssertEqual(VisibleAgentGoal(session(metadata: ["claudeSessionId": "c"], goal: ["status": "active", "source": "claude", "text": "ship", "sourceSessionId": "c", "observedAt": 1]))?.actions, [])
    }

    func testWhatEachButtonSends() {
        XCTAssertNil(VisibleAgentGoal.dispatch(.stop, current: "a", edited: nil), "stop sends nothing yet")
        XCTAssertEqual(VisibleAgentGoal.dispatch(.clear, current: "a", edited: nil)?.action, .clear)
        XCTAssertNil(VisibleAgentGoal.dispatch(.edit, current: "a", edited: nil), "cancelled")
        XCTAssertNil(VisibleAgentGoal.dispatch(.edit, current: "ship it", edited: " ship it "), "unchanged")
        XCTAssertNil(VisibleAgentGoal.dispatch(.edit, current: "a", edited: "   "), "emptied")
        let edit = VisibleAgentGoal.dispatch(.edit, current: "a", edited: " b ")
        XCTAssertEqual(edit?.action, .edit)
        XCTAssertEqual(edit?.objective, "b")
    }

    func testRigActivity() {
        let metadata: JSONValue = ["client": ["id": "rig"], "activity": [
            "subagents": ["running": 0, "queued": 2],
            "workflows": ["running": 0],
            "processes": ["running": 1],
            "tasks": ["pending": 3, "inProgress": 1],
        ]]
        XCTAssertEqual(RigActivityIndicator.indicators(metadata), [
            RigActivityIndicator(kind: .subagents, count: 0, queued: 2),
            RigActivityIndicator(kind: .processes, count: 1),
            RigActivityIndicator(kind: .tasks, count: 1, queued: 3),
        ])
        XCTAssertEqual(RigActivityIndicator.indicators(["activity": ["processes": ["running": 1]]]), [], "only Happy Agent sessions")
        XCTAssertEqual(RigActivityIndicator.indicators(["client": ["id": "rig"]]), [])
    }
}
