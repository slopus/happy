import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Answers `/v0/health` with `health` (a status alone when it is a
/// number) and `/v0/usage/daily` with one status, and says what it was
/// asked.
private actor DailyTransport: AgentTransport {
    static let serves = #"{"ready":true,"capabilities":{"dailyUsage":true}}"#
    let status: Int
    let body: String
    var health: String
    private(set) var paths: [String] = []
    init(status: Int, body: String = "{}", health: String = DailyTransport.serves) {
        self.status = status
        self.body = body
        self.health = health
    }

    func setHealth(_ health: String) { self.health = health }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        paths.append(path)
        if path == "/v0/health" {
            if let status = Int(health) { return HTTP1Response(status: status) }
            return HTTP1Response(status: 200, body: Data(health.utf8))
        }
        return HTTP1Response(status: status, body: Data(self.body.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

final class UsageOverviewTests: XCTestCase {
    private func counts(_ input: Int, output: Int = 0, read: Int = 0, write: Int = 0) -> JSONValue {
        .object(["input": .number(Double(input)), "output": .number(Double(output)), "cacheRead": .number(Double(read)), "cacheWrite": .number(Double(write))])
    }

    private func catalog(_ providers: [(id: String, name: String?, type: String, models: [String])]) -> ModelCatalog {
        let models = Set(providers.flatMap(\.models)).sorted().map { ModelCatalog.Model(id: $0, name: $0, efforts: [], defaultEffort: "medium") }
        return ModelCatalog(defaultProviderId: providers.first?.id ?? "", defaultModelId: "", models: models, providers: providers.map { provider in
            .init(id: provider.id, name: provider.name, type: provider.type, enabled: true, hidden: false, models: models.filter { provider.models.contains($0.id) })
        })
    }

    func testCompactReadsAsDesktopsNumbers() {
        XCTAssertEqual(UsageOverview.compact(0), "0")
        XCTAssertEqual(UsageOverview.compact(999), "999")
        XCTAssertEqual(UsageOverview.compact(1_000), "1K")
        XCTAssertEqual(UsageOverview.compact(162_300), "162.3K")
        XCTAssertEqual(UsageOverview.compact(505_000), "505K")
        XCTAssertEqual(UsageOverview.compact(696_840), "696.8K")
        XCTAssertEqual(UsageOverview.compact(999_950), "1M")
        XCTAssertEqual(UsageOverview.compact(2_000_000), "2M")
        XCTAssertEqual(UsageOverview.compact(5_700_000), "5.7M")
        XCTAssertEqual(UsageOverview.compact(11_640_000), "11.6M")
        XCTAssertEqual(UsageOverview.compact(134_700_000), "134.7M")
        XCTAssertEqual(UsageOverview.compact(1_400_000_000), "1.4B")
    }

    func testDaysAreCountedOnAFixedCalendar() {
        XCTAssertEqual(UsageDates.weekday("2026-11-09"), 0, "a Monday")
        XCTAssertEqual(UsageDates.weekday("2026-11-11"), 2)
        XCTAssertEqual(UsageDates.weekday("2026-11-15"), 6)
        XCTAssertEqual(UsageDates.adding(-364, to: "2026-11-11"), "2025-11-12")
        XCTAssertEqual(UsageDates.adding(1, to: "2028-02-28"), "2028-02-29")
        XCTAssertEqual(UsageDates.span(from: "2026-10-30", through: "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
        XCTAssertEqual(UsageDates.span(from: "2026-11-02", through: "2026-11-01"), [])
        XCTAssertTrue(UsageDates.isDay("2026-11-11"))
        XCTAssertFalse(UsageDates.isDay("2026-13-01"))
        XCTAssertFalse(UsageDates.isDay("2026-1-01"))
        XCTAssertFalse(UsageDates.isDay("yesterday"))
        // Late on the 11th in Los Angeles is already the 12th in UTC.
        let late = Date(timeIntervalSince1970: 1_794_466_800) // 2026-11-12T07:00Z
        XCTAssertEqual(UsageDates.day(late, in: TimeZone(identifier: "America/Los_Angeles")!), "2026-11-11")
        XCTAssertEqual(UsageDates.day(late, in: TimeZone(identifier: "UTC")!), "2026-11-12")
    }

    func testDailyHistoryReadsOnlyDaysFromSince() throws {
        let answer: JSONValue = .object([
            "since": .string("2026-11-01"),
            "days": .array([
                .object(["date": .string("2026-11-03"), "byProvider": .object(["a": .object(["m": counts(5, output: 1, read: 100, write: 2)])])]),
                .object(["date": .string("2026-10-31"), "byProvider": .object(["a": .object(["m": counts(9)])])]),
                .object(["date": .string("2026-11-02"), "byProvider": .object(["a": .object(["m": counts(-3)])])]),
                .object(["date": .string("not a day"), "byProvider": .object([:])]),
                .object(["date": .string("2026-11-04")]),
            ]),
        ])
        let history = try XCTUnwrap(DailyUsage.read(answer))
        XCTAssertEqual(history.since, "2026-11-01")
        XCTAssertEqual(history.days.map(\.date), ["2026-11-02", "2026-11-03"])
        XCTAssertEqual(history.days[0].providers["a"]?["m"], TokenCounts())
        XCTAssertEqual(history.days[1].providers["a"]?["m"]?.counted, 8, "input, output and cache writes; not cache reads")
        XCTAssertNil(DailyUsage.read(.object(["days": .array([])])), "nothing recorded is no history")
        XCTAssertNil(DailyUsage.read(.object(["since": .string("soon")])))
    }

    func testDaysFillTheGapsAndLevelsAreQuartiles() {
        let history = DailyUsage(since: "2026-11-01", days: [
            .init(date: "2026-11-02", providers: ["a": ["x": TokenCounts(input: 10)], "b": ["y": TokenCounts(input: 30), "x": TokenCounts(output: 5)]]),
            .init(date: "2026-11-04", providers: ["a": ["x": TokenCounts(input: 100, cacheRead: 9_999)]]),
        ])
        let days = UsageActivityDay.days(history, from: "2026-11-01", through: "2026-11-05")
        XCTAssertEqual(days.map(\.date), ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"])
        XCTAssertEqual(days.map(\.tokens), [0, 45, 0, 100, 0])
        XCTAssertEqual(days[1].models, [.init(id: "y", tokens: 30), .init(id: "x", tokens: 15)], "a model's tokens across accounts, most first")
        XCTAssertEqual(UsageActivityDay.days(history, from: "2026-11-01", through: "2026-11-05", provider: "a").map(\.tokens), [0, 10, 0, 100, 0])

        func day(_ tokens: Int) -> UsageActivityDay { .init(date: "", tokens: tokens, models: []) }
        // Used: 10 20 30 40 100; cuts at the 25/50/75% positions: 20, 30, 40.
        XCTAssertEqual(UsageActivityDay.levels([0, 10, 20, 30, 40, 100].map(day)), [0, 1, 1, 2, 3, 4])
        XCTAssertEqual(UsageActivityDay.levels([0, 0].map(day)), [0, 0])
        XCTAssertEqual(UsageActivityDay.levels([7].map(day)), [1], "one day alone is at every cut")
    }

    func testOverviewShowsOnlyWhatThereIsMostUsedFirst() throws {
        let catalog = catalog([
            ("grok-personal", "Personal", "grok", ["xai/grok"]),
            ("codex-work", "work@example.com", "codex", ["openai/gpt"]),
            ("claude-cli", "Current CLI", "claude", ["anthropic/opus", "anthropic/sonnet", "anthropic/haiku"]),
            ("claude-work", nil, "claude", ["anthropic/opus"]),
            ("claude-idle", "Idle", "claude", ["anthropic/opus"]),
        ])
        let usage: JSONValue = .object([
            "providers": .array([
                .object(["providerId": .string("codex-work"), "refreshedAt": .number(1_000), "refreshError": .string("429"), "signIn": .string("signed_out"), "usage": .object([
                    "planName": .string("Pro"), "exhausted": .bool(false),
                    "windows": .object(["weekly": .object(["usedPercent": .number(20)])]),
                ])]),
                // Only a failure: nothing to show.
                .object(["providerId": .string("grok-personal"), "error": .string("Unauthorized")]),
                // A plan name without windows shows nothing either.
                .object(["providerId": .string("claude-idle"), "usage": .object(["planName": .string("Max"), "windows": .object([:])])]),
            ]),
            "day": .object(["claude-cli": .object(["anthropic/opus": counts(10, read: 5)])]),
            "week": .object(["claude-cli": .object(["anthropic/opus": counts(100), "anthropic/sonnet": counts(300)])]),
            "month": .object([
                "claude-cli": .object(["anthropic/opus": counts(1_000), "anthropic/sonnet": counts(500), "anthropic/haiku": counts(0)]),
                "unlisted": .object(["some/model": counts(7)]),
            ]),
        ])
        let history = DailyUsage(since: "2026-11-01", days: [
            .init(date: "2026-11-02", providers: ["claude-work": ["anthropic/opus": TokenCounts(input: 50)], "codex-work": ["openai/gpt": TokenCounts(input: 40)]]),
            .init(date: "2026-11-10", providers: ["claude-cli": ["anthropic/opus": TokenCounts(input: 20)]]),
        ])
        let overview = UsageOverview.build(catalog: catalog, usage: usage, history: history, today: "2026-11-11")

        // Claude has 70 (50 + 20), Codex 40, the unlisted account none.
        XCTAssertEqual(overview.vendors.map(\.name), ["Claude", "Codex", nil])
        XCTAssertEqual(overview.vendors.map { $0.accounts.map(\.id) }, [["claude-work", "claude-cli"], ["codex-work"], ["unlisted"]])
        XCTAssertEqual(overview.vendors[0].accounts[0].name, "Claude Work", "an unnamed account reads its ID as words")
        XCTAssertEqual(overview.vendors[2].accounts[0].name, "Unlisted")

        let cli = overview.vendors[0].accounts[1]
        XCTAssertEqual(cli.models.map(\.id), ["anthropic/opus", "anthropic/sonnet"], "by month, the unused left out")
        XCTAssertEqual(cli.models[0].day, 15, "a model line counts cache reads")
        XCTAssertNil(cli.usage)
        XCTAssertEqual(cli.strip?.count, 11, "from since: 30 days back is before it")
        XCTAssertEqual(cli.strip?.last?.tokens, 0)

        let codex = overview.vendors[1].accounts[0]
        XCTAssertEqual(codex.plan, "Pro")
        XCTAssertEqual(codex.usage?.week?.left, 80)
        XCTAssertNil(codex.usage?.refreshError, "failures are left unsaid")
        XCTAssertEqual(codex.usage?.signedOut, false)
        XCTAssertEqual(codex.models, [])

        let activity = try XCTUnwrap(overview.activity)
        XCTAssertEqual(activity.days.first?.date, "2026-11-01")
        XCTAssertEqual(activity.days.last?.date, "2026-11-11")
        XCTAssertEqual(activity.tokens, 110)
        XCTAssertEqual(activity.since, "2026-11-01", "since falls inside the year")
    }

    func testAYearOfHistoryEndsTodayAndStartsAYearBack() throws {
        let history = DailyUsage(since: "2024-01-01", days: [
            .init(date: "2025-11-11", providers: ["a": ["m": TokenCounts(input: 1)]]),
            .init(date: "2025-11-12", providers: ["a": ["m": TokenCounts(input: 2)]]),
            .init(date: "2026-11-12", providers: ["a": ["m": TokenCounts(input: 4)]]),
        ])
        let activity = try XCTUnwrap(UsageOverview.build(catalog: nil, usage: nil, history: history, today: "2026-11-11").activity)
        XCTAssertEqual(activity.days.count, 365)
        XCTAssertEqual(activity.days.first?.date, "2025-11-12")
        XCTAssertEqual(activity.tokens, 2, "the day before the year and the day after today are out")
        XCTAssertNil(activity.since)
        XCTAssertNil(UsageOverview.build(catalog: nil, usage: nil, history: DailyUsage(since: "2026-11-01", days: []), today: "2026-11-11").activity, "nothing spent hides it")
    }

    func testLiveDailyUsageAsksForTheZoneAndHearsNoRouteAsUnsupported() async throws {
        let ok = DailyTransport(status: 200, body: #"{"since":"2026-11-01","days":[]}"#)
        let answer = await LiveDailyUsage(client: AgentClient(transport: ok, token: "t")).dailyUsage(days: 371, timeZone: "America/Los_Angeles")
        XCTAssertEqual(answer, .history(DailyUsage(since: "2026-11-01", days: [])))
        let paths = await ok.paths
        XCTAssertEqual(paths, ["/v0/health", "/v0/usage/daily?days=371&tz=America%2FLos_Angeles"])

        // A server that says it keeps one, yet has no such route.
        for (status, body) in [(404, "{}"), (501, "{}"), (400, #"{"code":"not_found","error":"No route"}"#)] {
            let answer = await LiveDailyUsage(client: AgentClient(transport: DailyTransport(status: status, body: body), token: "t")).dailyUsage(days: 371, timeZone: "UTC")
            XCTAssertEqual(answer, .unsupported, "\(status)")
        }
        let failed = await LiveDailyUsage(client: AgentClient(transport: DailyTransport(status: 500), token: "t")).dailyUsage(days: 371, timeZone: "UTC")
        XCTAssertEqual(failed, .failed)
        let nothing = await LiveDailyUsage(client: AgentClient(transport: DailyTransport(status: 200, body: "{}"), token: "t")).dailyUsage(days: 371, timeZone: "UTC")
        XCTAssertEqual(nothing, .history(nil))
    }

    func testFlagOnAsksAndHealthIsReadOnce() async throws {
        let server = DailyTransport(status: 200, body: #"{"since":"2026-11-01","days":[]}"#)
        let daily = LiveDailyUsage(client: AgentClient(transport: server, token: "t"))
        for _ in 0..<2 {
            let answer = await daily.dailyUsage(days: 371, timeZone: "UTC")
            XCTAssertEqual(answer, .history(DailyUsage(since: "2026-11-01", days: [])))
        }
        let paths = await server.paths
        XCTAssertEqual(paths, ["/v0/health", "/v0/usage/daily?days=371&tz=UTC", "/v0/usage/daily?days=371&tz=UTC"])
    }

    func testFlagOffOrMissingNeverAsks() async throws {
        for health in [
            #"{"ready":true,"capabilities":{"dailyUsage":false,"search":true}}"#,
            #"{"ready":true,"capabilities":{"search":true}}"#,
            #"{"ready":true}"#,
        ] {
            // It would answer, but isn't asked.
            let server = DailyTransport(status: 200, body: #"{"since":"2026-11-01","days":[]}"#, health: health)
            let daily = LiveDailyUsage(client: AgentClient(transport: server, token: "t"))
            for _ in 0..<2 {
                let answer = await daily.dailyUsage(days: 371, timeZone: "UTC")
                XCTAssertEqual(answer, .unsupported, health)
            }
            let paths = await server.paths
            XCTAssertEqual(paths, ["/v0/health"], health)
        }
    }

    func testUnreadHealthKeepsWhatWasShownAndIsReadAgain() async throws {
        let server = DailyTransport(status: 200, body: #"{"since":"2026-11-01","days":[]}"#, health: "503")
        let daily = LiveDailyUsage(client: AgentClient(transport: server, token: "t"))
        let first = await daily.dailyUsage(days: 371, timeZone: "UTC")
        XCTAssertEqual(first, .failed)
        await server.setHealth(DailyTransport.serves)
        let second = await daily.dailyUsage(days: 371, timeZone: "UTC")
        XCTAssertEqual(second, .history(DailyUsage(since: "2026-11-01", days: [])))
        let paths = await server.paths
        XCTAssertEqual(paths, ["/v0/health", "/v0/health", "/v0/usage/daily?days=371&tz=UTC"])
    }
}
