#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Settings › Usage over made-up readings, for the harness and the tests:
/// two Claude accounts and a Codex one with plans, a year of days (or the
/// last 40, or none), and a Grok account whose only reading failed, which
/// the page leaves out.
@MainActor
public enum UsagePreview {
    public enum History: String, Sendable { case year, recent, none, unsupported }

    public static let catalog: ModelCatalog = {
        func model(_ id: String) -> ModelCatalog.Model { .init(id: id, name: id, efforts: ["medium"], defaultEffort: "medium") }
        let models = ["anthropic/opus-5", "anthropic/sonnet-5", "openai/gpt-5.6-sol", "xai/grok-5"].map(model)
        return ModelCatalog(defaultProviderId: "claude-cli", defaultModelId: "anthropic/opus-5", models: models, providers: [
            .init(id: "claude-cli", name: "Current CLI", type: "claude", enabled: true, hidden: false, models: [models[0], models[1]]),
            .init(id: "claude-work", name: "work@example.com", type: "claude", enabled: true, hidden: false, models: [models[0]]),
            .init(id: "codex-work", name: "work@example.com", type: "codex", enabled: true, hidden: false, models: [models[2]]),
            .init(id: "grok-personal", name: "Personal", type: "grok", enabled: true, hidden: false, models: [models[3]]),
        ])
    }()

    /// `GET /v0/usage` as a server would answer at `now`.
    public static func usage(now: Date) -> JSONValue {
        let ms = now.timeIntervalSince1970 * 1000
        func minutes(_ count: Double) -> JSONValue { .number(ms + count * 60_000) }
        func window(_ used: Double, resetsIn: Double) -> JSONValue {
            .object(["usedPercent": .number(used), "resetsAt": minutes(resetsIn), "capturedAt": minutes(0)])
        }
        func counts(_ input: Double, _ output: Double, _ read: Double, _ write: Double) -> JSONValue {
            .object(["input": .number(input), "output": .number(output), "cacheRead": .number(read), "cacheWrite": .number(write)])
        }
        let providers: [JSONValue] = [
            .object(["providerId": .string("claude-cli"), "refreshedAt": minutes(0), "usage": .object([
                "capturedAt": minutes(0), "planName": .string("Max 20×"), "exhausted": .bool(false),
                "windows": .object(["weekly": window(81, resetsIn: 3 * 1440 + 312), "fiveHour": window(42, resetsIn: 133)]),
            ])]),
            .object(["providerId": .string("claude-work"), "refreshedAt": minutes(-5), "usage": .object([
                "capturedAt": minutes(-5), "planName": .string("Max 5×"), "exhausted": .bool(false),
                "windows": .object(["weekly": window(37, resetsIn: 2 * 1440 + 93), "fiveHour": window(12, resetsIn: 180)]),
            ])]),
            .object(["providerId": .string("codex-work"), "refreshedAt": minutes(-10), "error": .string("Request failed: 429 Too Many Requests"), "usage": .object([
                "capturedAt": minutes(-10), "planName": .string("Pro"), "exhausted": .bool(true),
                "windows": .object(["weekly": window(96, resetsIn: 4 * 1440), "fiveHour": window(100, resetsIn: 63)]),
            ])]),
            // A reading that only failed: nothing to show, so left out.
            .object(["providerId": .string("grok-personal"), "error": .string("Unauthorized: the API key was refused")]),
        ]
        return .object([
            "providers": .array(providers),
            "hour": .object(["claude-cli": .object(["anthropic/opus-5": counts(120_000, 40_000, 900_000, 30_000)])]),
            "day": .object([
                "claude-cli": .object(["anthropic/opus-5": counts(1_900_000, 600_000, 2_800_000, 400_000), "anthropic/sonnet-5": counts(62_000, 30_100, 50_000, 20_200)]),
                "claude-work": .object(["anthropic/opus-5": counts(250_000, 96_800, 300_000, 50_000)]),
            ]),
            "week": .object([
                "claude-cli": .object(["anthropic/opus-5": counts(12_400_000, 4_100_000, 18_200_000, 2_700_000), "anthropic/sonnet-5": counts(500_000, 260_000, 480_000, 160_000)]),
                "claude-work": .object(["anthropic/opus-5": counts(3_100_000, 900_000, 3_700_000, 600_000)]),
                "codex-work": .object(["openai/gpt-5.6-sol": counts(4_300_000, 1_600_000, 5_400_000, 800_000)]),
            ]),
            "month": .object([
                "claude-cli": .object(["anthropic/opus-5": counts(44_900_000, 15_200_000, 64_300_000, 10_300_000), "anthropic/sonnet-5": counts(2_200_000, 1_100_000, 2_500_000, 700_000)]),
                "codex-work": .object(["openai/gpt-5.6-sol": counts(16_800_000, 6_100_000, 21_900_000, 3_100_000)]),
            ]),
        ])
    }

    /// `GET /v0/usage/daily` over the year (or the last 40 days) to
    /// `today`: busier on weekdays and lately, some days with nothing.
    public static func history(_ kind: History, today: String) -> DailyUsageAnswer {
        let days: Int
        switch kind {
        case .none: return .history(nil)
        case .unsupported: return .unsupported
        case .year: days = 371
        case .recent: days = 40
        }
        var seed: UInt64 = 0x5EED_1234
        func random() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(1 << 53)
        }
        let since = UsageDates.adding(-(days - 1), to: today)
        var listed: [DailyUsage.Day] = []
        for (index, date) in UsageDates.span(from: since, through: today).enumerated() {
            let weekend = UsageDates.weekday(date) >= 5
            let roll = random()
            guard roll > (weekend ? 0.45 : 0.08) else { continue }
            let trend = 0.35 + 0.65 * Double(index) / Double(max(1, days - 1))
            let volume = 9_400_000 * trend * (weekend ? 0.3 : 1) * (0.25 + 1.5 * random())
            func split(_ share: Double) -> TokenCounts {
                let tokens = Int(volume * share)
                return TokenCounts(input: tokens * 55 / 100, output: tokens * 30 / 100, cacheRead: tokens * 2, cacheWrite: tokens * 15 / 100)
            }
            var providers: [String: [String: TokenCounts]] = [
                "claude-cli": ["anthropic/opus-5": split(0.52), "anthropic/sonnet-5": split(0.06)],
            ]
            if random() > 0.35 { providers["claude-work"] = ["anthropic/opus-5": split(0.22)] }
            if random() > 0.3 { providers["codex-work"] = ["openai/gpt-5.6-sol": split(0.2)] }
            listed.append(DailyUsage.Day(date: date, providers: providers))
        }
        return .history(DailyUsage(since: since, days: listed))
    }

    /// The page in its navigation, pushed from Settings; `tapsDay`, with a
    /// busy day of the last fortnight told, as a finger on it would.
    public static func make(history kind: History, tapsDay: Bool = false, now: Date = Date()) -> UIViewController {
        let today = UsageDates.day(now, in: .current)
        let page = UsageViewController(
            reader: FixtureUsageReader(usage: usage(now: now), catalog: catalog),
            daily: FixtureDailyUsage(history(kind, today: today)), now: { now }
        )
        let settings = UIViewController()
        settings.title = Strings.Settings.title
        settings.view.backgroundColor = UIColor(Palette.settingsGround)
        let navigation = UINavigationController(rootViewController: settings)
        navigation.pushViewController(page, animated: false)
        if tapsDay {
            Task { @MainActor [weak page] in
                while let page, page.overview == nil || page.isReading { try? await Task.sleep(for: .milliseconds(50)) }
                guard let page else { return }
                page.view.layoutIfNeeded()
                let days = page.activityGrid.days
                if let busy = days.indices.suffix(14).max(by: { days[$0].models.count * 1_000_000_000 + days[$0].tokens < days[$1].models.count * 1_000_000_000 + days[$1].tokens }) {
                    page.select((page.activityGrid, busy))
                }
            }
        }
        return navigation
    }
}
#endif
