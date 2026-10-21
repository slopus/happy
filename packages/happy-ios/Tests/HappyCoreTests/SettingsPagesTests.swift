import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private func machine(
    _ id: String,
    active: Bool = false,
    activeAt: Int64 = 1,
    _ metadata: [String: JSONValue]? = nil
) -> MachineRecord {
    MachineRecord(
        id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: activeAt,
        metadataVersion: 1, metadataCipher: "c", metadata: metadata.map(JSONValue.object),
        daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
    )
}

private func profile(
    firstName: String? = nil,
    lastName: String? = nil,
    github: GitHubProfile? = nil,
    avatar: ImageRef? = nil,
    services: [String] = []
) -> AccountProfile {
    AccountProfile(id: "p1", timestamp: 1, firstName: firstName, lastName: lastName, avatar: avatar, github: github, connectedServices: services)
}

/// components/SettingsView.tsx.
final class SettingsIndexModelTests: XCTestCase {
    func testTheLogoUntilTheAccountHasAFirstName() {
        XCTAssertEqual(SettingsIndexModel(profile: nil).header, .logo)
        let githubOnly = profile(github: GitHubProfile(id: 1, login: "ada", name: "Ada L"))
        XCTAssertEqual(SettingsIndexModel(profile: githubOnly).header, .logo, "a GitHub name alone keeps the logo")
        XCTAssertEqual(SettingsIndexModel(profile: profile(firstName: "")).header, .logo)
    }

    func testTheProfileHeader() {
        let model = SettingsIndexModel(profile: profile(
            firstName: "Ada",
            lastName: "Lovelace",
            github: GitHubProfile(id: 1, login: "ada", avatarURL: "https://a/ada.png", bio: "Math"),
            services: ["anthropic"]
        ))
        XCTAssertEqual(model.header, .profile(id: "p1", name: "Ada Lovelace", bio: "Math", avatarURL: "https://a/ada.png", thumbhash: nil))
        XCTAssertTrue(model.claudeConnected)
        XCTAssertEqual(model.githubLogin, "ada")
    }

    func testConnectionsWithoutAProfile() {
        let model = SettingsIndexModel(profile: profile(services: ["openai"]))
        XCTAssertFalse(model.claudeConnected)
        XCTAssertNil(model.githubLogin)
    }

    func testVersionDetail() {
        XCTAssertEqual(SettingsIndexModel.versionDetail(version: "2026.10.1", variant: .production), "2026.10.1")
        XCTAssertEqual(SettingsIndexModel.versionDetail(version: "2026.10.1", variant: .preview), "2026.10.1 / preview")
    }
}

/// hooks/useMultiClick.ts with Settings › Version's options.
final class MultiClickCounterTests: XCTestCase {
    func testTheTenthTapFiresAndStartsOver() {
        var counter = MultiClickCounter()
        let start = Date(timeIntervalSince1970: 0)
        for second in 0..<9 {
            XCTAssertFalse(counter.click(at: start + TimeInterval(second)))
        }
        XCTAssertTrue(counter.click(at: start + 9))
        XCTAssertEqual(counter.count, 0)
        XCTAssertFalse(counter.click(at: start + 10))
    }

    func testAPauseOfTwoSecondsResetsTheCount() {
        var counter = MultiClickCounter()
        let start = Date(timeIntervalSince1970: 0)
        for second in 0..<5 {
            _ = counter.click(at: start + TimeInterval(second))
        }
        XCTAssertFalse(counter.click(at: start + 6))
        XCTAssertEqual(counter.count, 1)
        for tap in 1..<9 {
            XCTAssertFalse(counter.click(at: start + 6 + TimeInterval(tap) * 0.5))
        }
        XCTAssertTrue(counter.click(at: start + 11))
    }
}

/// app/(app)/settings/account.tsx.
final class AccountPageModelTests: XCTestCase {
    func testProfileGroupAndKnownServices() {
        XCTAssertFalse(AccountPageModel(profile: nil).showsProfile)
        let page = AccountPageModel(profile: profile(
            github: GitHubProfile(id: 1, login: "ada"),
            services: ["openai", "somethingelse", "anthropic"]
        ))
        XCTAssertTrue(page.showsProfile)
        XCTAssertEqual(page.displayName, "ada")
        XCTAssertEqual(page.githubLogin, "ada")
        XCTAssertEqual(page.services, [.openai, .anthropic], "unknown services are left out, order kept")
        XCTAssertEqual(page.services.map(\.name), ["OpenAI Codex", "Claude Code"])
        XCTAssertEqual(page.services.map(\.tintsWithText), [true, false])
    }

    func testAPictureAloneShowsTheProfileGroup() {
        let avatar = ImageRef(width: 1, height: 1, thumbhash: "HwgK", path: "p", url: "https://a/p.png")
        let page = AccountPageModel(profile: profile(avatar: avatar))
        XCTAssertTrue(page.showsProfile)
        XCTAssertNil(page.displayName)
        XCTAssertEqual(page.avatarURL, "https://a/p.png")
        XCTAssertEqual(page.avatarThumbhash, "HwgK")
    }
}

/// sync/pushRegistration.ts and account.tsx's push copy.
final class PushPermissionTests: XCTestCase {
    func testSystemStatuses() {
        XCTAssertEqual(PushPermission(system: .notDetermined), PushPermission(status: .undetermined, granted: false, canAskAgain: true))
        XCTAssertEqual(PushPermission(system: .denied), PushPermission(status: .denied, granted: false, canAskAgain: false))
        XCTAssertEqual(PushPermission(system: .provisional), PushPermission(status: .granted, granted: true, canAskAgain: true))
    }

    func testLabels() {
        XCTAssertEqual(PushPermissionText.label(nil), "Loading")
        XCTAssertEqual(PushPermissionText.label(PushPermission(system: .authorized)), "Allowed")
        XCTAssertEqual(PushPermissionText.label(PushPermission(system: .denied)), "Denied")
        XCTAssertEqual(PushPermissionText.label(PushPermission(system: .notDetermined)), "Not requested")
        XCTAssertEqual(PushPermissionText.label(PushPermission(status: .unsupported, granted: false, canAskAgain: false)), "Unavailable")
    }

    func testSubtitles() {
        XCTAssertEqual(PushPermissionText.subtitle(nil), "Checking push notification permissions for this device.")
        XCTAssertEqual(PushPermissionText.subtitle(PushPermission(system: .authorized)), "This device can receive push notifications.")
        XCTAssertEqual(PushPermissionText.subtitle(PushPermission(system: .notDetermined)), "The system prompt can still be shown again from the app.")
        XCTAssertEqual(
            PushPermissionText.subtitle(PushPermission(system: .denied)),
            "iOS has stopped prompting. Open system settings to enable notifications again."
        )
        XCTAssertEqual(PushPermissionText.requestSubtitle(nil), "Opens system settings when iOS will not prompt again.")
        XCTAssertEqual(PushPermissionText.requestSubtitle(PushPermission(system: .notDetermined)), "Shows the system prompt again if iOS still allows it.")
        XCTAssertEqual(PushPermissionText.reregisterSubtitle(currentToken: nil), "Fetches the current Expo token and registers it again.")
        XCTAssertEqual(PushPermissionText.reregisterSubtitle(currentToken: "ExponentPushToken[abcdefghijklmnop]"), "Current token abcdef…klmnop")
    }

    func testThisDevicesTokenSubtitle() {
        let device = PushTokenText.Device(
            name: "Ada’s iPhone",
            model: "iPhone",
            systemName: "iOS",
            systemVersion: "18.0",
            appVersion: "2026.10.1",
            build: "42",
            isSimulator: false
        )
        XCTAssertEqual(device.deviceLabel, "Ada’s iPhone • iPhone • iOS 18.0")
        XCTAssertEqual(device.appLabel, "Happy 2026.10.1 • build 42")
        let token = PushToken(id: "t1", token: "ExponentPushToken[abcdefghijklmnop]", createdAt: 1, updatedAt: 2)
        XCTAssertEqual(
            PushTokenText.subtitle(token, current: device, format: { "at \($0)" }),
            "Ada’s iPhone • iPhone • iOS 18.0\nHappy 2026.10.1 • build 42\nRegistered: at 1\nLast seen: at 2\nServer ID: t1\nToken: abcdef…klmnop"
        )
    }

    func testDeviceLabelDropsARepeatedModel() {
        let simulator = PushTokenText.Device(name: "iPhone", model: "iPhone", systemName: "iOS", systemVersion: "18.0", appVersion: nil, build: nil, isSimulator: true)
        XCTAssertEqual(simulator.deviceLabel, "iPhone • iOS 18.0")
        XCTAssertEqual(simulator.appLabel, "simulator")
        let bare = PushTokenText.Device(name: nil, model: nil, systemName: "", systemVersion: nil, appVersion: nil, build: nil, isSimulator: false)
        XCTAssertEqual(bare.deviceLabel, "ios device")
        XCTAssertNil(bare.appLabel)
    }
}

final class AccountSwitcherEntryTests: XCTestCase {
    func testTitlesSubtitlesAndTheActiveProfile() {
        let base = ServerConfig.defaultServerURL
        let accounts = [
            AccountSummary(id: "aaaaaaaaaaaaaaaa", serverURL: base, isActive: true, usesSharedItem: true),
            AccountSummary(id: "bbbbbbbbbbbbbbbb", serverURL: URL(string: "http://10.0.0.2:3005")!, name: "Bea", username: "bea", isActive: false, usesSharedItem: false),
            AccountSummary(id: "cccccccccccccccc", serverURL: base, username: "cee", isActive: false, usesSharedItem: false),
            AccountSummary(id: "0123abcdef012345", serverURL: URL(string: "https://happy.example.com")!, isActive: false, usesSharedItem: false),
        ]
        let active = profile(firstName: "Ada", github: GitHubProfile(id: 1, login: "ada", avatarURL: "https://a/ada.png"))
        let entries = AccountSwitcherEntry.entries(accounts, activeProfile: active, defaultServer: base, fallbackTitle: "Account")
        XCTAssertEqual(entries.map(\.title), ["Ada", "Bea", "@cee", "Account 0123abcd"])
        XCTAssertEqual(entries.map(\.subtitle), ["@ada", "@bea • 10.0.0.2:3005", nil, "happy.example.com"])
        XCTAssertEqual(entries[0].avatarURL, URL(string: "https://a/ada.png"))
        XCTAssertNil(entries[1].avatarURL, "another account's profile is not this one's")
        XCTAssertEqual(entries.map(\.isActive), [true, false, false, false])
    }
}

/// changelog/storage.ts and changelog.tsx `parseSummary`.
final class ChangelogPageTests: XCTestCase {
    func testReadMarker() {
        let marker = ChangelogReadMarker(storage: InMemoryKeyValueStore())
        XCTAssertTrue(marker.hasUnread(latestTitle: "September 20"))
        marker.markViewed("September 20")
        XCTAssertEqual(marker.lastViewedTitle, "September 20")
        XCTAssertFalse(marker.hasUnread(latestTitle: "September 20"))
        XCTAssertTrue(marker.hasUnread(latestTitle: "October 1"))
        XCTAssertFalse(marker.hasUnread(latestTitle: ""))
    }

    func testLatestTitle() throws {
        XCTAssertEqual(try Changelog.decode(Data(#"{"entries":[],"latestTitle":"T"}"#.utf8)).latestTitle, "T")
        XCTAssertEqual(try Changelog.decode(Data(#"{"entries":[]}"#.utf8)).latestTitle, "")
    }

    func testSummarySegments() {
        XCTAssertEqual(
            ChangelogSummary.parse("Thank you [@a](https://x) and ![m](images/m.webp) end"),
            [.text("Thank you "), .link("@a", url: "https://x"), .text(" and "), .image(path: "images/m.webp"), .text(" end")]
        )
        XCTAssertEqual(ChangelogSummary.parse("a [b] (c) [d"), [.text("a [b] (c) [d")])
        XCTAssertEqual(ChangelogSummary.parse(""), [])
    }
}

/// app/(app)/settings/agents.tsx.
final class AgentsPageTests: XCTestCase {
    func testMachinesOnlineFirstThenMostRecent() {
        let rows = AgentsPage.machineRows([
            machine("m1", activeAt: 5, ["host": .string("old"), "platform": .string("darwin")]),
            machine("m2", active: true, activeAt: 3, ["displayName": .string("Work"), "platform": .string("linux")]),
            machine("m3", activeAt: 9, ["host": .string("mini")]),
        ], online: "online", offline: "offline")
        XCTAssertEqual(rows.map(\.name), ["Work", "mini", "old"])
        XCTAssertEqual(rows.map(\.subtitle), ["linux • online", "offline", "darwin • offline"])
        XCTAssertEqual(rows.map(\.online), [true, false, false])
        XCTAssertEqual(rows.map(\.targetMachineId), ["m2", "m3", "m1"])
    }

    func testAComputerOpensItsReachableDaemon() {
        let machines = [
            machine("r1", active: true, activeAt: 4, ["machineKind": .string("rig"), "siblingMachineId": .string("h1"), "host": .string("box")]),
            machine("h1", activeAt: 2, ["displayName": .string("Box"), "platform": .string("darwin"), "happyCliVersion": .string("1.2.6")]),
        ]
        let rows = AgentsPage.machineRows(machines, online: "online", offline: "offline")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].id, "h1")
        XCTAssertEqual(rows[0].name, "Box")
        XCTAssertEqual(rows[0].subtitle, "darwin • online")
        XCTAssertEqual(rows[0].targetMachineId, "r1")
        XCTAssertEqual(AgentsPage.defaultsCLIVersion(machines), "1.2.6")
        XCTAssertNil(AgentsPage.defaultsCLIVersion([]))
    }

    func testClaudeFieldsWithoutOverrides() {
        let fields = AgentsPage.fields(.claude, overrides: [:], cliVersion: "1.3.0")
        XCTAssertEqual(fields.map(\.field), [.permissionMode, .modelMode, .effortLevel])
        XCTAssertEqual(fields.map(\.title), ["Permission", "Model", "Effort"])
        XCTAssertEqual(fields.map(\.icon), ["shield-checkmark-outline", "hardware-chip-outline", "speedometer-outline"])
        XCTAssertEqual(fields.map(\.detail), ["Default (Auto)", "Default (Opus 5.5)", "Default (Medium)"])
        XCTAssertEqual(fields.map(\.codeDefaultName), ["Auto", "Opus 5.5", "Medium"])
        XCTAssertEqual(fields.map(\.hasOverride), [false, false, false])
        XCTAssertEqual(fields[1].options.count, 6)
        XCTAssertFalse(fields[1].offersCustomModel)
    }

    func testAnOverrideNamesItself() {
        let overrides: [String: JSONValue] = ["claude": .object(["permissionMode": .string("plan")])]
        let permission = AgentsPage.fields(.claude, overrides: overrides, cliVersion: "1.3.0")[0]
        XCTAssertEqual(permission.detail, "Plan")
        XCTAssertTrue(permission.hasOverride)
        XCTAssertEqual(permission.overrideValue, "plan")
    }

    func testCodexCustomModelIsListedAsAnOption() {
        let overrides: [String: JSONValue] = ["codex": .object(["modelMode": .string("my-model")])]
        let fields = AgentsPage.fields(.codex, overrides: overrides, cliVersion: "1.3.0")
        let model = fields[1]
        XCTAssertTrue(model.offersCustomModel)
        XCTAssertEqual(model.detail, "my-model")
        XCTAssertEqual(model.options.last, AgentDefaults.Option("my-model", "my-model", "custom model"))
        XCTAssertNil(model.customModel, "includeConfiguredModel lists it, so it is an option, not the custom row")
        XCTAssertEqual(fields[2].options.map(\.key), ["low", "medium", "high", "xhigh"])
    }

    func testAgentsWithoutModelsOrEffort() {
        XCTAssertEqual(AgentsPage.fields(.openclaw, overrides: [:], cliVersion: nil).map(\.field), [.permissionMode])
        XCTAssertEqual(AgentsPage.fields(.gemini, overrides: [:], cliVersion: nil).map(\.field), [.permissionMode, .modelMode])
        XCTAssertEqual(AgentsPage.fields(.agy, overrides: [:], cliVersion: nil).map(\.field), [.permissionMode, .modelMode, .effortLevel])
        XCTAssertEqual(AgentsPage.fields(.agy, overrides: [:], cliVersion: nil)[2].options.count, 3)
    }

    func testUnknownCLIDescribesTheOlderDefaults() {
        let model = AgentsPage.fields(.claude, overrides: [:], cliVersion: nil)[1]
        XCTAssertEqual(model.detail, "Default (Opus 5)")
    }
}

/// Settings › Agents worked out off the main thread: the groups a change
/// rebuilds, and the ones it leaves on screen.
final class AgentsPageDerivationTests: XCTestCase {
    private let allGroups: Set<AgentsPage.Group> = [.machines, .defaults, .agent(.claude), .agent(.codex), .agent(.agy)]

    override func setUp() async throws {
        // Catalogs are decoded off the main thread; these tests derive on it.
        for language in ["en", "ja"] { _ = await TranslationCatalog.load(language) }
    }

    private func input(_ machines: [MachineRecord], settings: SettingsSnapshot = SettingsSnapshot()) -> AgentsPage.Input {
        var input = AgentsPage.Input(language: "en")
        input.settings = settings
        input.machines = MachinesSnapshot(synced: true, machines: machines)
        return input
    }

    /// Three online, then the rest, ten apart so a heartbeat of a few
    /// seconds keeps the order.
    private func thousandComputers() -> [MachineRecord] {
        (0..<1000).map { machine("m\($0)", active: $0 < 3, activeAt: Int64(100_000 - $0 * 10), ["host": .string("host \($0)")]) }
    }

    private func settings(_ overrides: [String: JSONValue]) -> SettingsSnapshot {
        SettingsSnapshot(synced: AccountSettingsRecord(version: 1, cipher: nil, settings: .object(["agentDefaultOverrides": .object(overrides)])))
    }

    /// A first derivation, as the screen applies it.
    private func shown(_ input: AgentsPage.Input) throws -> AgentsPage.Content {
        try XCTUnwrap(AgentsPage.derive(input, applied: nil)).state
    }

    func testNothingUntilBothFeedsHaveSpoken() {
        var input = AgentsPage.Input(language: "en")
        XCTAssertNil(AgentsPage.derive(input, applied: nil))
        input.settings = SettingsSnapshot()
        XCTAssertNil(AgentsPage.derive(input, applied: nil), "no machines yet is not no machines")
        input.machines = MachinesSnapshot(synced: false, machines: [])
        let first = AgentsPage.derive(input, applied: nil)
        XCTAssertEqual(first?.output.rebuilt, allGroups)
        XCTAssertEqual(first?.state.machines, [])
        XCTAssertEqual(first?.state.groups, [.machines, .defaults, .agent(.claude), .agent(.codex), .agent(.agy)])
    }

    func testTheContentIsThePageFunctions() throws {
        let overrides: [String: JSONValue] = ["claude": .object(["permissionMode": .string("plan")])]
        let machines = [
            machine("m1", active: true, activeAt: 5, ["host": .string("box"), "happyCliVersion": .string("1.3.0")]),
            machine("m2", activeAt: 9, ["host": .string("mini")]),
        ]
        var page = input(machines, settings: settings(overrides))
        page.open = AgentsPage.OpenField(.codex, .modelMode)
        let content = try shown(page)
        XCTAssertEqual(content.machines, AgentsPage.machineRows(machines, online: "online", offline: "offline"))
        XCTAssertTrue(content.hasOverrides)
        XCTAssertEqual(content.agents.map(\.agent), AgentDefaults.Agent.configurable)
        XCTAssertEqual(content.agents[0].fields, AgentsPage.fields(.claude, overrides: overrides, cliVersion: "1.3.0"))
        XCTAssertEqual(content.agents.map(\.open), [nil, .modelMode, nil])
    }

    /// A heartbeat moves `activeAt` and nothing the page draws: the main
    /// thread hears nothing, for a thousand computers as for one.
    func testAHeartbeatThatKeepsTheOrderDerivesNothing() throws {
        let machines = thousandComputers()
        let before = try shown(input(machines))
        XCTAssertEqual(before.machines.count, 1000)
        var beat = machines
        beat[0].activeAt += 5
        beat[500].activeAt += 3
        XCTAssertNil(AgentsPage.derive(input(beat), applied: before))
        var unsynced = input(beat)
        unsynced.machines?.synced = false
        XCTAssertNil(AgentsPage.derive(unsynced, applied: before))
    }

    /// The row that changed, and nothing else: the group and its other
    /// rows stay on screen.
    func testAComputerGoingOfflineChangesOnlyItsRow() throws {
        let machines = [machine("m1", active: true, activeAt: 5, ["host": .string("box")]), machine("m2", activeAt: 3, ["host": .string("mini")])]
        let before = try shown(input(machines))
        var after = machines
        after[0].active = false
        let update = try XCTUnwrap(AgentsPage.derive(input(after), applied: before))
        XCTAssertEqual(update.output.rebuilt, [])
        let rows = try XCTUnwrap(update.output.machineRows)
        XCTAssertEqual(rows.updated.map(\.id), ["m1"])
        XCTAssertEqual(rows.updated.first?.subtitle, "offline")
        XCTAssertEqual(rows.inserted, [])
        XCTAssertEqual(rows.removed, [])
        XCTAssertNil(rows.order, "both keep their place")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(update.state.machines.map(\.subtitle), ["offline", "offline"])
    }

    /// A thousand computers, one of them seen again and moving up among the
    /// offline ones: no row changes what it shows, the rows only move.
    func testAHeartbeatThatReordersMovesRowsAndBuildsNone() throws {
        let machines = thousandComputers()
        let before = try shown(input(machines))
        var beat = machines
        beat[900].activeAt = 100_000 - 15
        let update = try XCTUnwrap(AgentsPage.derive(input(beat), applied: before))
        XCTAssertEqual(update.output.rebuilt, [])
        let rows = try XCTUnwrap(update.output.machineRows)
        XCTAssertEqual(rows.count, 0)
        XCTAssertEqual(rows.removed, [])
        XCTAssertEqual(rows.order?.count, 1000)
        XCTAssertEqual(rows.order?[3], "m900", "first of the offline computers")
        XCTAssertEqual(rows.order, update.state.machines.map(\.id))
    }

    func testComputersComingAndGoingAreBuiltAndDroppedByThemselves() throws {
        let machines = [machine("m1", active: true, activeAt: 5, ["host": .string("box")]), machine("m2", activeAt: 3, ["host": .string("mini")])]
        let before = try shown(input(machines))
        let after = [machines[0], machine("m3", activeAt: 4, ["host": .string("new")])]
        let rows = try XCTUnwrap(AgentsPage.derive(input(after), applied: before)?.output.machineRows)
        XCTAssertEqual(rows.inserted.map(\.id), ["m3"])
        XCTAssertEqual(rows.updated, [])
        XCTAssertEqual(rows.removed, ["m2"])
        XCTAssertEqual(rows.order, ["m1", "m3"])
    }

    /// "No machines" is a row of its own, so going to or from it builds the
    /// group again.
    func testTheFirstComputerAndTheLastRebuildTheGroup() throws {
        let none = try shown(input([]))
        let one = try XCTUnwrap(AgentsPage.derive(input([machine("m1", ["host": .string("box")])]), applied: none))
        XCTAssertEqual(one.output.rebuilt, [.machines])
        XCTAssertNil(one.output.machineRows)
        let gone = try XCTUnwrap(AgentsPage.derive(input([]), applied: one.state))
        XCTAssertEqual(gone.output.rebuilt, [.machines])
        XCTAssertNil(gone.output.machineRows)
    }

    /// The code defaults follow the first computer's CLI; the computers'
    /// own rows don't show it.
    func testANewCLIRebuildsTheAgentsItChangesAndNotTheComputers() throws {
        let old = [machine("m1", active: true, activeAt: 5, ["host": .string("box")])]
        let before = try shown(input(old))
        let new = [machine("m1", active: true, activeAt: 5, ["host": .string("box"), "happyCliVersion": .string("1.3.0")])]
        let update = try XCTUnwrap(AgentsPage.derive(input(new), applied: before))
        XCTAssertFalse(update.output.rebuilt.contains(.machines))
        XCTAssertNil(update.output.machineRows)
        XCTAssertFalse(update.output.rebuilt.contains(.defaults))
        XCTAssertTrue(update.output.rebuilt.contains(.agent(.claude)))
        XCTAssertEqual(update.state.agents[0].fields[1].detail, "Default (Opus 5.5)")
    }

    func testOpeningAFieldRebuildsItsAgentAndTheOneItClosed() throws {
        var page = input([])
        let before = try shown(page)
        page.open = AgentsPage.OpenField(.claude, .modelMode)
        let opened = try XCTUnwrap(AgentsPage.derive(page, applied: before))
        XCTAssertEqual(opened.output.rebuilt, [.agent(.claude)])
        page.open = AgentsPage.OpenField(.codex, .effortLevel)
        let moved = try XCTUnwrap(AgentsPage.derive(page, applied: opened.state))
        XCTAssertEqual(moved.output.rebuilt, [.agent(.claude), .agent(.codex)])
        page.open = AgentsPage.OpenField(.codex, .permissionMode)
        XCTAssertEqual(AgentsPage.derive(page, applied: moved.state)?.output.rebuilt, [.agent(.codex)])
    }

    /// A choice shows at once, and the settings feed echoing it back
    /// derives nothing more.
    func testAChoiceShowsBeforeTheFeedEchoesIt() throws {
        var page = input([])
        let before = try shown(page)
        let chosen: [String: JSONValue] = ["codex": .object(["permissionMode": .string("yolo")])]
        page.chosen = chosen
        XCTAssertEqual(page.overrides, chosen)
        let update = try XCTUnwrap(AgentsPage.derive(page, applied: before))
        XCTAssertEqual(update.output.rebuilt, [.defaults, .agent(.codex)])
        XCTAssertTrue(update.state.hasOverrides)
        // What the screen's follow does with the echo.
        page.settings = SettingsSnapshot(synced: nil, pending: ["agentDefaultOverrides": .object(chosen)])
        page.chosen = nil
        XCTAssertEqual(page.overrides, chosen)
        XCTAssertNil(AgentsPage.derive(page, applied: update.state))
    }

    func testClearingRebuildsTheDefaultsAndEveryAgentItTouched() throws {
        let overrides: [String: JSONValue] = ["claude": .object(["effortLevel": .string("high")])]
        var page = input([], settings: settings(overrides))
        let before = try shown(page)
        page.chosen = [:]
        let update = try XCTUnwrap(AgentsPage.derive(page, applied: before))
        XCTAssertEqual(update.output.rebuilt, [.defaults, .agent(.claude)])
        XCTAssertFalse(update.state.hasOverrides)
    }

    /// The language is part of what the page says: the same computers in
    /// another language are another page.
    func testTheLanguageInTheInputSaysTheWords() throws {
        let machines = [machine("m1", active: true, activeAt: 5, ["host": .string("box")])]
        let english = try shown(input(machines))
        XCTAssertEqual(english.machines.map(\.subtitle), ["online"])
        var japanese = input(machines)
        japanese.language = "ja"
        let update = try XCTUnwrap(AgentsPage.derive(japanese, applied: english))
        XCTAssertEqual(update.state.machines.map(\.subtitle), ["オンライン"])
        // The computer's row says its words in place; the group stays.
        XCTAssertEqual(update.output.rebuilt, [])
        let rows = try XCTUnwrap(update.output.machineRows)
        XCTAssertEqual(rows.updated.map(\.id), ["m1"])
        XCTAssertEqual(rows.updated.map(\.subtitle), ["オンライン"])
        XCTAssertNil(rows.order)
    }

    /// Two accounts' screens, built in two languages, derive at the same
    /// time while the screens' language keeps changing underneath them:
    /// each says only its own words, because each read its language from
    /// its input and never from `AppLocalization`.
    @MainActor
    func testTwoAccountsInTwoLanguagesKeepTheirOwnWords() async {
        let japaneseCatalog = await TranslationCatalog.load("ja")
        defer { AppLocalization.use(nil) }
        func pipeline(_ language: String, _ recorder: ApplyPerfRecorder<AgentsPage.Update>) -> ApplyPipeline<AgentsPage.Input, AgentsPage.Content?, AgentsPage.Update> {
            ApplyPipeline(
                input: AgentsPage.Input(language: language),
                state: nil,
                minimumInterval: .zero,
                derive: { AgentsPage.derive($0, applied: $1) },
                apply: { recorder.take($0) }
            )
        }
        let englishOutputs = ApplyPerfRecorder<AgentsPage.Update>()
        let japaneseOutputs = ApplyPerfRecorder<AgentsPage.Update>()
        let english = pipeline("en", englishOutputs)
        let japanese = pipeline("ja", japaneseOutputs)
        let flips = Task.detached {
            for index in 0..<2000 { AppLocalization.use(index.isMultiple(of: 2) ? japaneseCatalog : nil) }
        }
        var machines = [machine("m1", active: true, activeAt: 5, ["host": .string("box")]), machine("m2", activeAt: 3, ["host": .string("mini")])]
        for both in [english, japanese] { both.update { $0.settings = SettingsSnapshot() } }
        for beat in 0..<20 {
            machines[0].active = beat.isMultiple(of: 2)
            for both in [english, japanese] { both.update { [machines] in $0.machines = MachinesSnapshot(synced: true, machines: machines) } }
            await Task.yield()
        }
        await flips.value
        await applyPerfWait(timeout: 30) {
            english.applied?.machines.first?.subtitle == "offline" && japanese.applied?.machines.first?.subtitle == "オフライン"
        }
        let englishWords = Set(englishOutputs.outputs.flatMap { $0.content.machines.map(\.subtitle) })
        let japaneseWords = Set(japaneseOutputs.outputs.flatMap { $0.content.machines.map(\.subtitle) })
        XCTAssertFalse(englishOutputs.outputs.isEmpty)
        XCTAssertFalse(japaneseOutputs.outputs.isEmpty)
        XCTAssertTrue(englishWords.isSubset(of: ["online", "offline"]), "\(englishWords)")
        XCTAssertTrue(japaneseWords.isSubset(of: ["オンライン", "オフライン"]), "\(japaneseWords)")
        english.cancel()
        japanese.cancel()
    }

    /// Through the real pipeline: one apply for the page, none for a burst
    /// of heartbeats over a thousand computers, and every derivation off
    /// the main thread (ApplyPipeline checks that in Debug).
    @MainActor
    func testHeartbeatsThroughThePipelineNeverReachTheMainThread() async {
        let recorder = ApplyPerfRecorder<AgentsPage.Update>()
        let pipeline = ApplyPipeline<AgentsPage.Input, AgentsPage.Content?, AgentsPage.Update>(
            input: AgentsPage.Input(language: "en"),
            state: nil,
            minimumInterval: .zero,
            derive: { AgentsPage.derive($0, applied: $1) },
            apply: { recorder.take($0) }
        )
        var machines = thousandComputers()
        pipeline.update { $0.settings = SettingsSnapshot() }
        pipeline.update { [machines] in $0.machines = MachinesSnapshot(synced: true, machines: machines) }
        await applyPerfWait(timeout: 30) { pipeline.counts.applies == 1 }
        let quiet = pipeline.counts.unchanged
        for beat in 1...5 {
            machines[0].activeAt += 1
            pipeline.update { [machines] in $0.machines = MachinesSnapshot(synced: true, machines: machines) }
            await applyPerfWait(timeout: 30) { pipeline.counts.unchanged == quiet + beat }
        }
        XCTAssertEqual(pipeline.counts.applies, 1)
        XCTAssertEqual(recorder.outputs.count, 1)
        XCTAssertEqual(recorder.outputs.first?.rebuilt.count, 5)
        XCTAssertEqual(pipeline.applied?.machines.count, 1000)
        pipeline.cancel()
    }
}

/// Vectors from thumbhash@0.1.1's own `rgbaToThumbHash` and
/// `thumbHashToRGBA`, run under node on three generated images.
final class ThumbHashTests: XCTestCase {
    private func pixel(_ image: ThumbHash.Image, _ x: Int, _ y: Int) -> [UInt8] {
        let start = (y * image.width + x) * 4
        return Array(image.rgba[start..<start + 4])
    }

    private func check(
        _ base64: String, size: (Int, Int), first: [UInt8], middle: [UInt8], last: [UInt8], sum: Int,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let image = try XCTUnwrap(ThumbHash.decode(base64: base64), file: file, line: line)
        XCTAssertEqual(image.width, size.0, file: file, line: line)
        XCTAssertEqual(image.height, size.1, file: file, line: line)
        XCTAssertEqual(pixel(image, 0, 0), first, file: file, line: line)
        XCTAssertEqual(pixel(image, image.width >> 1, image.height >> 1), middle, file: file, line: line)
        XCTAssertEqual(pixel(image, image.width - 1, image.height - 1), last, file: file, line: line)
        XCTAssertEqual(image.rgba.reduce(0) { $0 + Int($1) }, sum, file: file, line: line)
    }

    func testSquare() throws {
        try check("HwgKPxxwd3dweHiHiHiHd4h3Bwd4gI8I", size: (32, 32), first: [13, 0, 139, 255], middle: [130, 144, 116, 255], last: [230, 198, 73, 255], sum: 646_841)
    }

    func testLandscapeWithoutPadding() throws {
        try check("HwgKPJxwd3dweHiHiHdwgAf3iA", size: (32, 18), first: [6, 0, 141, 255], middle: [142, 144, 120, 255], last: [227, 213, 80, 255], sum: 364_200)
    }

    func testPortraitWithAlpha() throws {
        try check("W5eFGw43M0B3eHczQDjzi4+IiIiIiHg=", size: (19, 32), first: [14, 42, 127, 255], middle: [109, 128, 121, 113], last: [72, 158, 117, 23], sum: 270_241)
    }

    func testGarbageIsNil() {
        XCTAssertNil(ThumbHash.decode(base64: "not base64!"))
        XCTAssertNil(ThumbHash.decode([1, 2]))
    }
}
