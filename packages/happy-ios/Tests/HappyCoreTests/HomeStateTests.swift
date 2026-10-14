import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private func machine(
    _ id: String,
    active: Bool = false,
    activeAt: Int64 = 1,
    createdAt: Int64 = 1,
    _ metadata: [String: JSONValue]? = nil
) -> MachineRecord {
    MachineRecord(
        id: id, seq: 0, createdAt: createdAt, updatedAt: 1, active: active, activeAt: activeAt,
        metadataVersion: 1, metadataCipher: "c", metadata: metadata.map(JSONValue.object),
        daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
    )
}

private func session(_ id: String, updatedAt: Int64, _ metadata: [String: JSONValue]) -> SessionRecord {
    SessionRecord(
        id: id, seq: 0, createdAt: 1, updatedAt: updatedAt, active: false, activeAt: updatedAt,
        projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
        agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
        dataKeyCipher: "k", decryptable: true
    )
}

/// Cases from happy-app's sync/machineChoices.test.ts and
/// components/onboarding/firstRunOnboarding.ts.
final class MachineChoiceTests: XCTestCase {
    func testOneMachineIsOneComputerNamedByDisplayNameThenHost() {
        let choices = MachineChoice.collect([
            machine("a", ["displayName": .string("Work"), "host": .string("work.local")]),
            machine("b", ["displayName": .string(""), "host": .string("home.local")]),
            machine("c"),
        ])
        XCTAssertEqual(choices.map(\.name), ["Work", "home.local", "Unknown machine"])
        XCTAssertEqual(choices.map(\.machineIds), [["a"], ["b"], ["c"]])
    }

    func testHappyAgentJoinsItsHappyCLIMachineFromEitherSide() {
        let cli = machine("cli", active: false, activeAt: 5, ["displayName": .string("MacBook"), "host": .string("mbp")])
        let rig = machine("rig", active: true, activeAt: 9, [
            "displayName": .string("MacBook (Happy Agent)"),
            "host": .string("mbp"),
            "machineKind": .string("rig"),
            "siblingMachineId": .string("cli"),
        ])
        for order in [[cli, rig], [rig, cli]] {
            let choices = MachineChoice.collect(order)
            XCTAssertEqual(choices.count, 1)
            XCTAssertEqual(choices.first?.id, "cli", "Happy CLI's machine is the computer's id")
            XCTAssertEqual(choices.first?.name, "MacBook")
            XCTAssertEqual(choices.first?.happyMachine?.id, "cli")
            XCTAssertEqual(choices.first?.rigMachine?.id, "rig")
            XCTAssertEqual(choices.first?.online, true, "either daemon being up counts")
            XCTAssertEqual(choices.first?.activeAt, 9)
            XCTAssertEqual(Set(choices.first?.machineIds ?? []), ["cli", "rig"])
        }
    }

    func testTwoAgentRegistrationsOfOneLaptopStayOneComputer() {
        // Neither agent names the other; both name the CLI machine. Newest
        // first, so the agents are seen before the machine they point at.
        let choices = MachineChoice.collect([
            machine("rig-new", active: true, activeAt: 9, ["rigOnly": .bool(true), "siblingMachineId": .string("cli")]),
            machine("rig-old", activeAt: 3, ["client": .object(["id": .string("rig")]), "siblingMachineId": .string("cli")]),
            machine("cli", ["host": .string("laptop")]),
        ])
        XCTAssertEqual(choices.count, 1)
        XCTAssertEqual(choices.first?.rigMachine?.id, "rig-new", "the reachable registration wins")
        XCTAssertEqual(Set(choices.first?.machineIds ?? []), ["rig-new", "rig-old", "cli"])
    }

    func testAComputerWithOnlyHappyAgentGoesByHost() {
        let choices = MachineChoice.collect([
            machine("rig", ["displayName": .string("studio (Happy Agent)"), "host": .string("studio"), "cliAvailability": .object(["rig": .bool(true)])]),
        ])
        XCTAssertEqual(choices.first?.name, "studio")
        XCTAssertNil(choices.first?.happyMachine)
    }

    func testSharingAHostNameIsNotPairing() {
        let choices = MachineChoice.collect([
            machine("a", ["host": .string("same")]),
            machine("b", ["host": .string("same")]),
        ])
        XCTAssertEqual(choices.count, 2)
    }

    func testAPointerToAnUnknownMachineIsIgnored() {
        let choices = MachineChoice.collect([machine("rig", ["machineKind": .string("rig"), "siblingMachineId": .string("gone")])])
        XCTAssertEqual(choices.first?.machineIds, ["rig"])
    }
}

/// `MachineChoice.collect` reads the sibling pointers once for the list; the
/// groups, their order and every member's order stay those of happy-app's
/// per-machine scan, kept here as the reference.
final class MachineChoicePairingIndexTests: XCTestCase {
    /// sync/agentSessionPlaces.ts `pairedMachineIds` and
    /// machineChoices.ts `connectedMachineIds`, as they read.
    private func referenceIds(_ start: MachineRecord, _ machines: [MachineRecord], _ byId: [String: MachineRecord]) -> [String] {
        func paired(_ machine: MachineRecord) -> [String] {
            var ids = [machine.id]
            if let sibling = machine.metadata?["siblingMachineId"]?.stringValue, !sibling.isEmpty, !ids.contains(sibling) {
                ids.append(sibling)
            }
            for candidate in machines where candidate.metadata?["siblingMachineId"]?.stringValue == machine.id {
                if !ids.contains(candidate.id) { ids.append(candidate.id) }
            }
            return ids
        }
        var found = [start.id]
        var seen: Set<String> = [start.id]
        var pending = [start]
        while let machine = pending.popLast() {
            for id in paired(machine) {
                guard let next = byId[id], !seen.contains(id) else { continue }
                seen.insert(id)
                found.append(id)
                pending.append(next)
            }
        }
        return found
    }

    private func reference(_ machines: [MachineRecord]) -> [[String]] {
        let byId = Dictionary(machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var grouped = Set<String>()
        var groups: [[String]] = []
        for machine in machines where !grouped.contains(machine.id) {
            let ids = referenceIds(machine, machines, byId)
            grouped.formUnion(ids)
            groups.append(ids)
        }
        return groups
    }

    private func rig(_ id: String, to sibling: String, activeAt: Int64 = 1) -> MachineRecord {
        machine(id, activeAt: activeAt, ["machineKind": .string("rig"), "siblingMachineId": .string(sibling)])
    }

    func testOddPointersGroupAsBefore() {
        let lists: [[MachineRecord]] = [
            // Agents first, pointing at a CLI further down; one points at another agent.
            [rig("r1", to: "cli"), rig("r2", to: "cli"), rig("r3", to: "r1"), machine("cli"), machine("x")],
            // A chain, a cycle, a self pointer, an empty and a dangling one.
            [rig("a", to: "b"), rig("b", to: "c"), rig("c", to: "a"), rig("self", to: "self"), rig("empty", to: ""), rig("gone", to: "nowhere")],
            // A duplicate id: the first record is the machine.
            [machine("d", ["host": .string("first")]), rig("r", to: "d"), machine("d", ["host": .string("second")])],
            // Two CLIs claimed by one agent through a third.
            [machine("cli1"), rig("r1", to: "cli1"), rig("r2", to: "r1"), rig("r3", to: "cli2"), machine("cli2"), rig("r4", to: "r2")],
        ]
        for machines in lists {
            XCTAssertEqual(MachineChoice.collect(machines).map(\.machineIds), reference(machines))
        }
    }

    func testAThousandMachinesWithSiblingsGroupAsBefore() {
        var machines: [MachineRecord] = []
        for index in 0..<1000 {
            switch index % 4 {
            case 0: machines.append(rig("m\(index)", to: "m\(index + 3)", activeAt: Int64(index)))
            case 1: machines.append(rig("m\(index)", to: "m\(index + 2)", activeAt: Int64(index)))
            case 2: machines.append(machine("m\(index)", ["host": .string("h\(index)")]))
            default: machines.append(machine("m\(index)", activeAt: Int64(index)))
            }
        }
        let choices = MachineChoice.collect(machines)
        XCTAssertEqual(choices.map(\.machineIds), reference(machines))
        XCTAssertEqual(choices.count, 500)
    }

    /// Linear in the machines: ten times the list costs nowhere near a
    /// hundred times the time, as the per-machine scan did.
    func testCollectingScalesWithTheList() {
        func list(_ count: Int) -> [MachineRecord] {
            (0..<count).map { index in
                index.isMultiple(of: 2)
                    ? rig("m\(index)", to: "m\(index + 1)", activeAt: Int64(index))
                    : machine("m\(index)", activeAt: Int64(index), ["host": .string("h\(index)")])
            }
        }
        let small = list(400)
        let large = list(4000)
        let smallTime = applyPerfMedian(5) { _ = MachineChoice.collect(small) }
        let largeTime = applyPerfMedian(5) { _ = MachineChoice.collect(large) }
        XCTAssertLessThan(largeTime, max(smallTime, 0.05) * 40, "\(smallTime)ms for 400, \(largeTime)ms for 4000")
    }
}

final class HomeStateTests: XCTestCase {
    private func home(_ machines: [MachineRecord], synced: Bool = true, _ sessions: [SessionRecord] = []) -> HomeState {
        HomeState(HomeSnapshot(machines: MachinesSnapshot(synced: synced, machines: machines), sessions: sessions))
    }

    private func live(_ id: String, rig: Bool = false) -> SessionRecord {
        var record = session(id, updatedAt: 5, rig ? ["client": .object(["id": .string("rig")])] : [:])
        record.active = !rig
        return record
    }

    func testNothingFetchedYetIsLoadingNotLink() {
        // An account restored from another phone has computers; asking it
        // to link one before the first fetch would be wrong.
        XCTAssertEqual(HomeState(MachinesSnapshot(synced: false, machines: [])), .loading)
    }

    func testNoComputerAfterAFetchIsLink() {
        XCTAssertEqual(HomeState(MachinesSnapshot(synced: true, machines: [])), .link)
    }

    func testComputersAllOfflineWithNothingListedIsOffline() {
        let state = home([machine("a"), machine("b")])
        guard case .offline(let choices, let hasArchived) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(choices.map(\.id), ["a", "b"])
        XCTAssertFalse(hasArchived)
    }

    func testTheOfflineChecklistKnowsAboutTheArchive() {
        // Archived rows are hidden by default, so nothing is listed.
        let state = home([machine("a")], [session("old", updatedAt: 5, [:])])
        guard case .offline(_, let hasArchived) = state else { return XCTFail("\(state)") }
        XCTAssertTrue(hasArchived)
    }

    func testLiveSessionsListEvenWhileEveryComputerIsOffline() {
        // A Happy Agent session stays live while disconnected.
        let state = home([machine("a")], [live("s", rig: true)])
        guard case .list(let list, let offline) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(list.items.compactMap(\.sessionId), ["s"])
        XCTAssertEqual(offline?.map(\.id), ["a"])
    }

    func testAReachableComputerClearsTheOfflinePlaque() {
        let state = home([machine("a"), machine("b", active: true)], [live("s")])
        guard case .list(_, let offline) = state else { return XCTFail("\(state)") }
        XCTAssertNil(offline)
    }

    func testAReachableComputerWithNoSessionsIsNoSessions() {
        XCTAssertEqual(home([machine("a", active: true)]), .noSessions)
    }

    func testOnlyAnArchiveListsTheToggle() {
        let state = home([machine("a", active: true)], [session("old", updatedAt: 5, [:])])
        guard case .list(let list, nil) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(list.items, [.archiveToggle(hidden: true)])
    }

    func testSessionsListWithoutAnyComputer() {
        let state = home([], [live("s")])
        guard case .list(_, nil) = state else { return XCTFail("\(state)") }
    }

    func testStoredMachinesShowBeforeTheFirstFullFetch() {
        XCTAssertEqual(home([machine("a", active: true)], synced: false), .noSessions)
    }
}

final class OfflineTroubleshootingTests: XCTestCase {
    func testNewestSessionOnAKnownComputerPicksMachineAndProject() {
        let choices = MachineChoice.collect([
            machine("recent", activeAt: 50, ["displayName": .string("Recent")]),
            machine("work", activeAt: 10, ["displayName": .string("Work"), "happyHomeDir": .string("/Users/me/.happy-dev")]),
        ])
        let sessions = [
            session("elsewhere", updatedAt: 300, ["machineId": .string("unknown")]),
            session("newest", updatedAt: 200, ["machineId": .string("work"), "path": .string("/src/happy-ios/")]),
            session("older", updatedAt: 100, ["machineId": .string("recent"), "project": .object(["name": .string("Old")])]),
        ]
        let guide = OfflineTroubleshooting(choices: choices, sessions: sessions)
        XCTAssertEqual(guide.machineName, "Work")
        XCTAssertEqual(guide.projectName, "happy-ios")
        XCTAssertEqual(guide.happyHomeDir, "/Users/me/.happy-dev")
        XCTAssertEqual(
            guide.aiPrompt,
            #"In /Users/me/.happy-dev, diagnose why Happy cannot reach "Work" for project "happy-ios"."#
        )
    }

    func testWithoutSessionsTheMostRecentComputerAndDefaults() {
        let choices = MachineChoice.collect([
            machine("a", activeAt: 1, ["displayName": .string("Old")]),
            machine("b", activeAt: 7, ["displayName": .string("New")]),
        ])
        let guide = OfflineTroubleshooting(choices: choices, sessions: [])
        XCTAssertEqual(guide.aiPrompt, #"In ~/.happy, diagnose why Happy cannot reach "New" for project "Happy"."#)
        XCTAssertEqual(OfflineTroubleshooting(choices: [], sessions: []).machineName, "this machine")
    }

    func testProjectNameFromPath() {
        XCTAssertEqual(OfflineTroubleshooting.projectName(fromPath: " /a/b// "), "b")
        XCTAssertEqual(OfflineTroubleshooting.projectName(fromPath: #"C:\code\app\"#), "app")
        XCTAssertNil(OfflineTroubleshooting.projectName(fromPath: "/"))
        XCTAssertNil(OfflineTroubleshooting.projectName(fromPath: nil))
    }
}

final class LocalSettingsTests: XCTestCase {
    func testChecklistStartsUntickedAndRoundTrips() {
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        XCTAssertEqual(settings.linkComputerChecklist, LinkChecklist())
        XCTAssertFalse(settings.linkComputerChecklist.isComplete)
        settings.linkComputerChecklist = LinkChecklist(install: true, open: true)
        XCTAssertTrue(settings.linkComputerChecklist.isComplete)
    }

    func testReadsHappyAppsPartialRecord() {
        let storage = InMemoryKeyValueStore(["linkComputerChecklist": #"{"install":true}"#])
        XCTAssertEqual(LocalSettings(storage: storage).linkComputerChecklist, LinkChecklist(install: true, open: false))
    }

    @MainActor
    func testSignOutClearsTheChecklist() async {
        let storage = InMemoryKeyValueStore()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            localSettings: storage,
            transport: FakeHTTP(),
            connector: FakeConnector()
        )
        controller.localSettings.linkComputerChecklist = LinkChecklist(install: true, open: true)
        await controller.signOut()
        XCTAssertEqual(controller.localSettings.linkComputerChecklist, LinkChecklist())
        XCTAssertNil(storage.string(forKey: "linkComputerChecklist"))
    }
}
