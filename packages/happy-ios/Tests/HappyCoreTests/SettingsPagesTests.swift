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
        XCTAssertEqual(model.header, .profile(id: "p1", name: "Ada Lovelace", bio: "Math", avatarURL: "https://a/ada.png"))
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
        let avatar = ImageRef(width: 1, height: 1, thumbhash: "", path: "p", url: "https://a/p.png")
        let page = AccountPageModel(profile: profile(avatar: avatar))
        XCTAssertTrue(page.showsProfile)
        XCTAssertNil(page.displayName)
        XCTAssertEqual(page.avatarURL, "https://a/p.png")
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
