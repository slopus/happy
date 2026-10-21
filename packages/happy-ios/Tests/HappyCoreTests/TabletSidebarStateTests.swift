import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// What the tablet sidebar shows: SidebarView.tsx's archive button,
/// MainView.tsx's sidebar variant and EmptySessionsTablet.tsx's faces.
final class TabletSidebarStateTests: XCTestCase {
    private func machine(_ id: String, active: Bool, name: String? = nil) -> MachineRecord {
        MachineRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(name.map { ["displayName": .string($0)] } ?? [:]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    /// Live while `active`; a Happy CLI session that is not active is
    /// archived.
    private func session(_ id: String, active: Bool) -> SessionRecord {
        SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 5, active: active, activeAt: 5,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object([:]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
    }

    private func state(
        _ machines: [MachineRecord],
        synced: Bool = true,
        _ sessions: [SessionRecord] = [],
        settings: [String: JSONValue] = [:]
    ) -> TabletSidebarState {
        TabletSidebarState(HomeSnapshot(
            machines: MachinesSnapshot(synced: synced, machines: machines),
            sessions: sessions,
            settings: SettingsSnapshot(pending: settings)
        ))
    }

    func testASpinnerUntilMachinesAreKnown() {
        let sidebar = state([], synced: false)
        XCTAssertEqual(sidebar.content, .loading)
        XCTAssertFalse(sidebar.showsInstallStep)
    }

    func testNoComputerIsTheInstallStepTheShellStepsAsideFor() {
        let sidebar = state([])
        XCTAssertTrue(sidebar.showsInstallStep)
        XCTAssertEqual(sidebar.content, .empty(.noMachines))
    }

    func testLiveSessionsList() {
        let sidebar = state([machine("m", active: true)], [session("s", active: true)])
        guard case .list(let list, let offline) = sidebar.content else { return XCTFail("\(sidebar.content)") }
        XCTAssertEqual(list.items.compactMap(\.sessionId), ["s"])
        XCTAssertNil(offline)
        XCTAssertFalse(sidebar.hasArchived)
        XCTAssertFalse(sidebar.showsInstallStep)
    }

    func testTheOfflinePlaqueRidesOnTheList() {
        let sidebar = state([machine("m", active: false)], [session("s", active: true)])
        guard case .list(_, let offline) = sidebar.content else { return XCTFail("\(sidebar.content)") }
        XCTAssertEqual(offline?.map(\.id), ["m"])
    }

    func testAHiddenArchiveListsNothingButOffersTheButton() {
        // Phone home lists the archive toggle here; the sidebar shows
        // EmptySessionsTablet and the archive button above it.
        let sidebar = state([machine("m", active: true)], [session("old", active: false)])
        XCTAssertEqual(sidebar.content, .empty(.online))
        XCTAssertTrue(sidebar.hasArchived)
        XCTAssertTrue(sidebar.hidesArchived)
    }

    func testAShownArchiveIsListed() {
        let sidebar = state([machine("m", active: true)], [session("old", active: false)], settings: ["hideInactiveSessions": .bool(false)])
        guard case .list(let list, _) = sidebar.content else { return XCTFail("\(sidebar.content)") }
        XCTAssertEqual(list.items.compactMap(\.sessionId), ["old"])
        XCTAssertFalse(sidebar.hidesArchived)
    }

    func testEveryComputerOfflineWithNothingListed() {
        let one = state([machine("m", active: false, name: "Studio")])
        guard case .empty(.offline(let choices)) = one.content else { return XCTFail("\(one.content)") }
        XCTAssertEqual(choices.map(\.name), ["Studio"])
        let two = state([machine("a", active: false), machine("b", active: false)])
        guard case .empty(.offline(let both)) = two.content else { return XCTFail("\(two.content)") }
        XCTAssertEqual(both.count, 2)
    }

    func testAReachableComputerWithNoSessions() {
        XCTAssertEqual(state([machine("m", active: true)]).content, .empty(.online))
    }

    func testEmptyFacesFromMachineChoices() {
        XCTAssertEqual(TabletEmptySessions([]), .noMachines)
        let online = MachineChoice.collect([machine("a", active: false), machine("b", active: true)])
        XCTAssertEqual(TabletEmptySessions(online), .online)
    }
}

/// localSettings.ts `zenMode`: off until the zen control turns it on,
/// device-only, and cleared with the account's other local settings.
final class TabletZenModeTests: XCTestCase {
    func testZenModeRoundTripsAndClears() {
        let storage = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: storage)
        XCTAssertFalse(settings.zenMode)
        settings.zenMode = true
        XCTAssertTrue(settings.zenMode)
        XCTAssertEqual(storage.string(forKey: "zenMode"), "true")
        settings.clear()
        XCTAssertFalse(settings.zenMode)
        XCTAssertNil(storage.string(forKey: "zenMode"))
    }
}
