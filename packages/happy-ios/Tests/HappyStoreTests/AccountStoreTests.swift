import Foundation
import GRDB
import XCTest
@testable import HappyStore
import HappyWire

/// The local-only session fields (storage.ts `applySessions`), pending
/// settings, projects and the profile.
final class SessionLocalStateTests: XCTestCase {
    var store: LocalStore!

    override func setUpWithError() throws {
        store = try LocalStore.inMemory()
    }

    private let permission: JSONValue = .object(["requests": .object(["r1": .object(["tool": .string("Bash")])])])

    private func session(_ id: String = "s") throws -> SessionRecord {
        try XCTUnwrap(try store.session(id: id))
    }

    func testAFinishedTurnIsUnreadUntilRead() throws {
        try store.upsertSessions([makeSession("s")])
        try store.applySessionActivity(id: "s", active: true, activeAt: 200, thinking: true)
        XCTAssertTrue(try session().thinking)
        XCTAssertFalse(try session().unread)

        try store.applySessionActivity(id: "s", active: true, activeAt: 210, thinking: false)
        XCTAssertFalse(try session().thinking)
        XCTAssertTrue(try session().unread)

        try store.markSessionRead(id: "s")
        XCTAssertFalse(try session().unread)
    }

    func testAnAnsweredPermissionIsUnread() throws {
        try store.upsertSessions([makeSession("s")])
        _ = try store.applySessionUpdate(id: "s", metadata: nil, agentState: VersionedPayload(version: 1, cipher: "a", value: permission), projectId: nil)
        XCTAssertFalse(try session().unread, "waiting on the person is not a finished turn")
        _ = try store.applySessionUpdate(id: "s", metadata: nil, agentState: VersionedPayload(version: 2, cipher: "b", value: .object([:])), projectId: nil)
        XCTAssertTrue(try session().unread)
    }

    func testGoingOfflineStopsThinkingWithoutMarkingUnread() throws {
        try store.upsertSessions([makeSession("s")])
        try store.applySessionActivity(id: "s", active: true, activeAt: 200, thinking: true)
        try store.applySessionActivity(id: "s", active: false, activeAt: 220, thinking: true)
        XCTAssertFalse(try session().thinking, "a dead session never sends the ephemeral that clears it")
        XCTAssertFalse(try session().unread)
    }

    func testAnOlderActivityIsIgnored() throws {
        try store.upsertSessions([makeSession("s", updatedAt: 100)])
        try store.applySessionActivity(id: "s", active: false, activeAt: 50)
        XCTAssertTrue(try session().active)
    }

    func testANewSessionStartsWithNoLocalState() throws {
        var incoming = makeSession("s")
        incoming.thinking = true
        incoming.unread = true
        incoming.archiving = true
        try store.upsertSessions([incoming])
        let stored = try session()
        XCTAssertFalse(stored.thinking || stored.unread || stored.archiving)
    }

    func testAnArchiveInFlightEndsWhenTheServerAgrees() throws {
        try store.upsertSessions([makeSession("s", updatedAt: 100)])
        try store.setSessionArchiving(id: "s", true)
        XCTAssertTrue(try session().isArchived)

        var later = makeSession("s", updatedAt: 110)
        later.active = true
        try store.upsertSessions([later])
        XCTAssertTrue(try session().archiving, "still running on the server")

        try store.applySessionActivity(id: "s", active: false, activeAt: 120)
        XCTAssertFalse(try session().archiving)
        XCTAssertTrue(try session().isArchived)
    }

    func testReopeningClearsStaleLiveState() throws {
        let queue = try DatabaseQueue()
        let first = try LocalStore(writer: queue)
        try first.upsertSessions([makeSession("s")])
        try first.applySessionActivity(id: "s", active: true, activeAt: 200, thinking: true)
        try first.setSessionArchiving(id: "s", true)
        try first.applySessionActivity(id: "s", active: true, activeAt: 210, thinking: false)

        let reopened = try XCTUnwrap(try LocalStore(writer: queue).session(id: "s"))
        XCTAssertFalse(reopened.thinking)
        XCTAssertFalse(reopened.archiving)
        XCTAssertTrue(reopened.unread, "unread survives a relaunch")
    }

    func testRigSessionsStayLiveWhileDisconnected() {
        var rig = makeSession("s", metadata: .object(["client": .object(["id": .string("rig")])]))
        rig.active = false
        XCTAssertFalse(rig.isArchived)
        rig.metadata = .object(["client": .object(["id": .string("rig")]), "lifecycleState": .string("archived")])
        XCTAssertTrue(rig.isArchived)
    }
}

final class PendingSettingsTests: XCTestCase {
    var store: LocalStore!

    override func setUpWithError() throws {
        store = try LocalStore.inMemory()
    }

    func testChangesMergeAndShowInTheSnapshot() throws {
        try store.addPendingSettings(["a": .bool(true)])
        try store.addPendingSettings(["b": .string("x"), "a": .bool(false)])
        XCTAssertEqual(try store.pendingSettings(), ["a": .bool(false), "b": .string("x")])
        XCTAssertEqual(try store.settingsSnapshot().pending, ["a": .bool(false), "b": .string("x")])
    }

    func testSettlingKeepsKeysChangedAgainSinceTheSend() throws {
        try store.addPendingSettings(["a": .bool(true), "b": .number(1)])
        let sent = try store.pendingSettings()
        try store.addPendingSettings(["b": .number(2)])
        try store.settlePendingSettings(sent: sent)
        XCTAssertEqual(try store.pendingSettings(), ["b": .number(2)])
        try store.settlePendingSettings(sent: ["b": .number(2)])
        XCTAssertEqual(try store.pendingSettings(), [:])
    }

    func testAConflictTakesTheServersVersionEvenIfLower() throws {
        try store.applyAccountSettings(AccountSettingsRecord(version: 5, cipher: "c5", settings: .object([:])))
        try store.replaceAccountSettings(AccountSettingsRecord(version: 3, cipher: "c3", settings: .object(["x": .bool(true)])))
        XCTAssertEqual(try store.accountSettings()?.version, 3)
    }

    func testEraseClearsEverythingAccountLevel() throws {
        try store.addPendingSettings(["a": .bool(true)])
        try store.applyProfile(AccountProfile(id: "u", timestamp: 1, firstName: "Ada"))
        try store.replaceProjects([makeProject("p")])
        try store.eraseAll()
        XCTAssertEqual(try store.pendingSettings(), [:])
        XCTAssertNil(try store.profile())
        XCTAssertEqual(try store.projects(), [])
    }
}

func makeProject(_ id: String, version: Int = 1, name: String = "Project") -> ProjectRecord {
    ProjectRecord(
        id: id, externalId: "ext-\(id)", createdAt: 1, updatedAt: 1, metadataVersion: version,
        metadataCipher: "c\(version)", metadata: .object(["name": .string(name)]), dataKeyCipher: nil
    )
}

final class ProjectAndProfileStoreTests: XCTestCase {
    var store: LocalStore!

    override func setUpWithError() throws {
        store = try LocalStore.inMemory()
    }

    func testReferencedProjectIdsAreDistinctAndNonEmpty() throws {
        var a = makeSession("a")
        a.projectId = "p2"
        var b = makeSession("b")
        b.projectId = "p1"
        var c = makeSession("c")
        c.projectId = "p2"
        var d = makeSession("d")
        d.projectId = ""
        try store.upsertSessions([a, b, c, d, makeSession("e")])
        XCTAssertEqual(try store.referencedProjectIds(), ["p1", "p2"])
    }

    func testReplacingProjectsDropsUnreturnedOnesAndKeepsNewerVersions() throws {
        try store.replaceProjects([makeProject("keep", version: 5, name: "New"), makeProject("gone")])
        try store.replaceProjects([makeProject("keep", version: 4, name: "Old")])
        XCTAssertEqual(try store.projects().map(\.id), ["keep"])
        XCTAssertEqual(try store.projects().first?.name, "New")
    }

    func testDeletingAProjectUnlinksItsSessions() throws {
        var linked = makeSession("s")
        linked.projectId = "p"
        try store.upsertSessions([linked])
        try store.replaceProjects([makeProject("p")])
        try store.deleteProject(id: "p")
        XCTAssertEqual(try store.projects(), [])
        XCTAssertNil(try store.session(id: "s")?.projectId)
    }

    func testAProjectNameMustBeNonEmpty() {
        XCTAssertNil(makeProject("p", name: "").name)
    }

    func testAnOlderProfileSnapshotLosesToANewerPatch() throws {
        try store.applyProfile(AccountProfile(id: "u", timestamp: 10, firstName: "Ada", lastName: "Lovelace"))
        try store.patchProfile(UpdateAccountUpdate(id: "u", firstName: .some("Grace"), github: .some(nil)), at: 20)
        var profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.firstName, "Grace")
        XCTAssertEqual(profile.lastName, "Lovelace", "fields the patch lacks stay")
        XCTAssertNil(profile.github)
        XCTAssertEqual(profile.timestamp, 20)

        XCTAssertFalse(try store.applyProfile(AccountProfile(id: "u", timestamp: 15, firstName: "Stale")))
        profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.firstName, "Grace")
    }

    func testASettingsOnlyUpdateLeavesTheProfileAlone() throws {
        try store.patchProfile(UpdateAccountUpdate(id: "u", settings: VersionedValue(version: 2, value: "c")), at: 30)
        XCTAssertNil(try store.profile())
    }

    func testHomeSnapshotCarriesEverythingTheListNeeds() throws {
        try store.upsertSessions([makeSession("s")])
        try store.replaceProjects([makeProject("p")])
        try store.addPendingSettings(["hideInactiveSessions": .bool(false)])
        let snapshot = try store.homeSnapshot()
        XCTAssertEqual(snapshot.sessions.map(\.id), ["s"])
        XCTAssertEqual(snapshot.projects.map(\.id), ["p"])
        XCTAssertEqual(snapshot.settings.pending["hideInactiveSessions"], .bool(false))
        XCTAssertFalse(snapshot.machines.synced)
    }
}
