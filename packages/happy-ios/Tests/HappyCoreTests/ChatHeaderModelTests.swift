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
