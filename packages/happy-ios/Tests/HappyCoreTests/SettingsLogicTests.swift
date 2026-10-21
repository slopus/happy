import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Cases from happy-app's sync/agentDefaults.test.ts and
/// utils/versionUtils.test.ts.
final class AgentDefaultsTests: XCTestCase {
    func testCodeDefaultsFollowTheCLIVersion() {
        XCTAssertEqual(AgentDefaults.codeDefaults(.claude, cliVersion: "1.2.6").modelMode, "claude-opus-5-5")
        XCTAssertEqual(AgentDefaults.codeDefaults(.claude, cliVersion: "1.2.6-beta.0").modelMode, "claude-opus-5-5")
        XCTAssertEqual(AgentDefaults.codeDefaults(.claude, cliVersion: "1.2.5").modelMode, "claude-opus-5")
        XCTAssertEqual(AgentDefaults.codeDefaults(.claude, cliVersion: nil).modelMode, "claude-opus-5", "unknown CLI keeps the old Opus")
        XCTAssertEqual(AgentDefaults.codeDefaults(.claude, cliVersion: nil).permissionMode, "auto", "unknown CLI keeps auto")
        XCTAssertEqual(AgentDefaults.codeDefaults(.codex, cliVersion: "1.2.0").permissionMode, "default")
        XCTAssertEqual(AgentDefaults.codeDefaults(.codex, cliVersion: "garbage").permissionMode, "default")
        XCTAssertEqual(AgentDefaults.codeDefaults(.codex, cliVersion: "1.2.1-beta.2").permissionMode, "auto")
    }

    func testOverridesWinAndRetiredKeysMapForward() {
        let overrides: [String: JSONValue] = [
            "claude": .object(["permissionMode": .string("dontAsk"), "modelMode": .string("claude-opus-5-5[1m]")]),
        ]
        let config = AgentDefaults.resolve(overrides, .claude, cliVersion: "1.3.0")
        XCTAssertEqual(config.permissionMode, "acceptEdits")
        XCTAssertEqual(config.modelMode, "claude-opus-5-5")
        XCTAssertEqual(config.effortLevel, "medium")
    }

    func testSettingAndClearingAnOverride() {
        var overrides = AgentDefaults.setting([:], .codex, .modelMode, to: "gpt-6-sol")
        XCTAssertEqual(overrides, ["codex": .object(["modelMode": .string("gpt-6-sol")])])
        overrides = AgentDefaults.setting(overrides, .codex, .effortLevel, to: "high")
        overrides = AgentDefaults.setting(overrides, .codex, .modelMode, to: nil)
        XCTAssertEqual(overrides, ["codex": .object(["effortLevel": .string("high")])])
        overrides = AgentDefaults.setting(overrides, .codex, .effortLevel, to: nil)
        XCTAssertEqual(overrides, [:], "an agent with nothing left is removed")
    }

    func testModelRowsKeepASavedModelThatLeftTheCatalog() {
        let codex = AgentDefaults.modelModes(.codex, configured: "my-model")
        XCTAssertEqual(codex.last, AgentDefaults.Option("my-model", "my-model", "custom model"))
        let claude = AgentDefaults.modelModes(.claude, configured: "claude-sonnet-5")
        XCTAssertEqual(claude.last?.name, "Sonnet 5")
        XCTAssertEqual(AgentDefaults.modelModes(.claude, configured: "claude-opus-5-5[1m]").count, 6, "maps onto an existing row")
    }

    func testEffortLevelsPerModel() {
        XCTAssertEqual(AgentDefaults.effortLevels(.claude, model: "x").map(\.name), ["Low", "Medium", "High", "xHigh", "Max"])
        XCTAssertEqual(AgentDefaults.effortLevels(.codex, model: "gpt-6-luna").count, 5)
        XCTAssertEqual(AgentDefaults.effortLevels(.codex, model: "custom").map(\.key), ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(AgentDefaults.effortLevels(.agy, model: "GPT-OSS 120B (Medium)"), [])
    }

    func testOptionName() {
        let options = AgentDefaults.permissionModes(.claude)
        XCTAssertEqual(AgentDefaults.optionName(options, "plan"), "Plan")
        XCTAssertEqual(AgentDefaults.optionName(options, "mystery"), "mystery")
        XCTAssertEqual(AgentDefaults.optionName(options, nil), "none")
    }

    func testRetiredAgentsAreNotConfigurable() {
        XCTAssertEqual(AgentDefaults.Agent.configurable, [.claude, .codex, .agy])
    }
}

final class SemanticVersionTests: XCTestCase {
    func testComparison() {
        XCTAssertEqual(SemanticVersion.compare("1.2.3", "1.2.3"), 0)
        XCTAssertEqual(SemanticVersion.compare("1.2.3", "1.10.0"), -1)
        XCTAssertEqual(SemanticVersion.compare("1.2.3-beta.1", "1.2.3"), -1)
        XCTAssertEqual(SemanticVersion.compare("1.2.3-beta.2", "1.2.3-beta.10"), -1)
        XCTAssertEqual(SemanticVersion.compare("1.2.3-beta", "1.2.3-alpha"), 1)
        XCTAssertEqual(SemanticVersion.compare("1.2.3-1", "1.2.3-alpha"), -1, "numeric identifiers sort first")
        XCTAssertEqual(SemanticVersion.compare("1.2.3+build", "1.2.3"), 0)
    }

    func testWellFormed() {
        XCTAssertTrue(SemanticVersion.isWellFormed("1.2.3"))
        XCTAssertTrue(SemanticVersion.isWellFormed("1.2.3-beta.2+sha.1"))
        XCTAssertFalse(SemanticVersion.isWellFormed("1.2"))
        XCTAssertFalse(SemanticVersion.isWellFormed("v1.2.3"))
    }
}

final class AccountDetailsTests: XCTestCase {
    func testPushTokenFingerprint() {
        XCTAssertEqual(PushTokenText.fingerprint("ExponentPushToken[abcdefghijklmnop]"), "abcdef…klmnop")
        XCTAssertEqual(PushTokenText.fingerprint("short"), "short")
    }

    func testPushTokenSubtitle() {
        let token = PushToken(id: "t1", token: "ExponentPushToken[abcdefghijklmnop]", createdAt: 1, updatedAt: 2)
        XCTAssertEqual(
            PushTokenText.subtitle(token, format: { "at \($0)" }),
            "Other device or stale registration\nRegistered: at 1\nLast seen: at 2\nServer ID: t1\nToken: abcdef…klmnop"
        )
    }

    func testUsageTotalsAndTopModels() {
        let totals = UsageTotals([
            UsageDataPoint(timestamp: 1, tokens: ["opus": 1_000, "sonnet": 500], cost: ["opus": 0.5], reportCount: 1),
            UsageDataPoint(timestamp: 2, tokens: ["opus": 2_000, "haiku": 500], cost: ["opus": 1, "haiku": 0.25], reportCount: 1),
        ])
        XCTAssertEqual(totals.totalTokens, 4_000)
        XCTAssertEqual(totals.totalCost, 1.75)
        XCTAssertEqual(totals.topModels.map(\.model), ["opus", "haiku", "sonnet"])
    }

    func testUsageFormatting() {
        XCTAssertEqual(UsageTotals.formatTokens(1_234_567), "1.23M")
        XCTAssertEqual(UsageTotals.formatTokens(4_500), "4.5K")
        XCTAssertEqual(UsageTotals.formatTokens(999, locale: Locale(identifier: "en_US")), "999")
        XCTAssertEqual(UsageTotals.formatCost(1.5), "$1.5000")
    }

    func testUsagePeriods() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_000_000)
        let today = UsageTotals.Period.today.query(now: now, calendar: calendar)
        XCTAssertEqual(today.groupBy, .hour)
        XCTAssertEqual(today.startTime, Int64(calendar.startOfDay(for: now).timeIntervalSince1970))
        XCTAssertEqual(today.endTime, 1_000_000)
        let week = UsageTotals.Period.sevenDays.query(now: now, calendar: calendar)
        XCTAssertEqual(week.groupBy, .day)
        XCTAssertEqual(week.startTime, 1_000_000 - 7 * 86_400)
    }

    func testServerIDIsTheTokensSubject() {
        // {"sub":"cm_user-1"} with base64url padding stripped.
        let payload = Data(#"{"sub":"cm_user-1"}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        XCTAssertEqual(AccountSession.subject(ofToken: "h.\(payload).s"), "cm_user-1")
        XCTAssertNil(AccountSession.subject(ofToken: "not-a-jwt"))
    }
}

final class ChangelogTests: XCTestCase {
    func testDecodesHappyAppsFile() throws {
        let json = #"{"entries":[{"title":"T","summary":"","markdown":"- a","titleImage":"x.webp"}],"latestTitle":"T"}"#
        let changelog = try Changelog.decode(Data(json.utf8))
        XCTAssertEqual(changelog.entries, [Changelog.Entry(title: "T", summary: "", markdown: "- a")])
    }

    func testBlocksAndSpans() {
        let blocks = ChangelogMarkdown.parse("- **Bots** — make one.\n- Credits: [@f-liva](https://github.com/f-liva).\n\nA paragraph\ncontinues.")
        XCTAssertEqual(blocks, [
            .bullet([.text("Bots", bold: true), .text(" — make one.", bold: false)]),
            .bullet([.text("Credits: ", bold: false), .link("@f-liva", url: "https://github.com/f-liva"), .text(".", bold: false)]),
            .paragraph([.text("A paragraph continues.", bold: false)]),
        ])
    }

    func testUnclosedMarkersStayText() {
        XCTAssertEqual(ChangelogMarkdown.spans("2 ** 3 [x"), [.text("2 ** 3 [x", bold: false)])
    }
}
