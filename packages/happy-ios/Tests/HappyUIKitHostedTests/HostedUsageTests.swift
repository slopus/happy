#if canImport(UIKit)
import Foundation
@testable import HappyCore
@testable import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// Answers the daily history from a list, the last one again once it runs
/// out, and counts how often it was asked.
private actor ScriptedDaily: DailyUsageSource {
    private var answers: [DailyUsageAnswer]
    private(set) var asked = 0
    init(_ answers: [DailyUsageAnswer]) { self.answers = answers }

    func dailyUsage(days: Int, timeZone: String) async -> DailyUsageAnswer {
        asked += 1
        return answers.count > 1 ? answers.removeFirst() : answers[0]
    }
}

@MainActor
final class HostedUsageTests: XCTestCase {
    private let now = Date()
    private var today: String { UsageDates.day(now, in: .current) }

    private func page(_ daily: any DailyUsageSource) -> UsageViewController {
        UsageViewController(reader: FixtureUsageReader(usage: UsagePreview.usage(now: now), catalog: UsagePreview.catalog), daily: daily, now: { [now] in now })
    }

    private func host(_ controller: UIViewController) async throws -> UIWindow {
        let navigation = UINavigationController(rootViewController: controller)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        return window
    }

    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    func testShowsWhatThereIsMostUsedFirstAndNoFailure() async throws {
        let page = page(FixtureDailyUsage(UsagePreview.history(.year, today: today)))
        let window = try await host(page)
        try await until { page.overview != nil }
        window.layoutIfNeeded()

        XCTAssertEqual(page.shownSections.map(\.name), ["Claude", "Codex"], "Grok's only reading failed: no section")
        XCTAssertEqual(page.shownSections.first?.accounts, ["claude-cli", "claude-work"])
        let texts = page.shownTexts
        XCTAssertEqual(texts.first, "Activity")
        XCTAssertTrue(texts[1].hasSuffix(" tokens in the last year"), texts[1])
        for failure in ["Unauthorized", "429", "Too Many", "Signed out", "couldn’t", "Couldn’t", "Personal"] {
            XCTAssertFalse(texts.contains { $0.contains(failure) }, "\(failure) is on the page: \(texts)")
        }
        let cli = try XCTUnwrap(page.accountView("claude-cli"))
        XCTAssertEqual(Array(cli.texts.prefix(2)), ["Current CLI", "Max 20×"])
        XCTAssertTrue(cli.texts.contains("Week") && cli.texts.contains("Session") && cli.texts.contains("Updated just now"), "\(cli.texts)")
        XCTAssertTrue(cli.texts.contains("anthropic/opus-5"))
        XCTAssertTrue(cli.texts.contains("5.7M day · 37.4M week · 134.7M month"), "\(cli.texts)")
        XCTAssertEqual(cli.strip.days.count, 30)
        let codex = try XCTUnwrap(page.accountView("codex-work"))
        XCTAssertTrue(codex.texts.contains { $0.hasPrefix("Limit resets ") }, "\(codex.texts)")
        XCTAssertTrue(codex.texts.contains("Updated 10 min ago"), "a failed refresh still says when it was read: \(codex.texts)")

        // The year: every day back to a year ago, opening on today.
        let grid = page.activityGrid
        XCTAssertEqual(grid.days.count, 365)
        XCTAssertEqual(grid.days.last?.date, today)
        XCTAssertEqual(grid.viewport.contentOffset.x, max(0, grid.viewport.contentSize.width - grid.viewport.bounds.width), accuracy: 0.5)
        XCTAssertEqual(grid.plot.monthNames.last.map { $0.count }, 3)
        // Every card is inside the page's column and nothing overlaps.
        let cards = page.scroll.subviews.filter { $0.layer.cornerRadius == UsageMetrics.radius && !$0.isHidden }.map(\.frame)
        XCTAssertEqual(cards.count, 3)
        for (above, below) in zip(cards, cards.dropFirst()) { XCTAssertLessThan(above.maxY, below.minY) }
        XCTAssertLessThanOrEqual(page.scroll.contentSize.height, (cards.last?.maxY ?? 0) + UsageMetrics.bottom + 0.5)
    }

    func testTappingADayTellsItsDateTotalAndModels() async throws {
        let page = page(FixtureDailyUsage(UsagePreview.history(.year, today: today)))
        let window = try await host(page)
        try await until { page.overview != nil }
        window.layoutIfNeeded()
        let grid = page.activityGrid
        let busy = try XCTUnwrap(grid.days.indices.last { grid.days[$0].models.count >= 3 })
        page.select((grid, busy))
        let texts = try XCTUnwrap(page.calloutTexts)
        let day = grid.days[busy]
        XCTAssertEqual(texts.first, Strings.Usage.callout(day.date))
        XCTAssertEqual(texts[1], Strings.Usage.tokens(day.tokens))
        XCTAssertEqual(texts.count, 2 + 2 * 3, "at most three models, each with its total")
        XCTAssertEqual(texts[2], day.models[0].id)
        XCTAssertEqual(grid.selected, busy)
        let shown = page.scroll.convert(page.calloutFrame, to: page.view)
        XCTAssertTrue(page.view.bounds.contains(shown), "\(shown) outside \(page.view.bounds)")
        XCTAssertLessThan(shown.maxY, grid.convert(grid.cell(busy, in: grid), to: page.view).minY + 0.5, "over its cell")

        let quiet = try XCTUnwrap(grid.days.indices.last { grid.days[$0].tokens == 0 })
        page.select((grid, quiet))
        XCTAssertEqual(page.calloutTexts, [Strings.Usage.callout(grid.days[quiet].date), "No usage"])
        XCTAssertEqual(grid.selected, quiet)

        let strip = try XCTUnwrap(page.accountView("claude-cli")?.strip)
        page.select((strip, 29))
        XCTAssertNil(grid.selected, "one day is told at a time")
        XCTAssertEqual(page.calloutTexts?.first, Strings.Usage.callout(today))
        page.select(nil)
        XCTAssertNil(page.calloutTexts)
        XCTAssertNil(strip.selected)
    }

    func testRecentHistorySaysSince() async throws {
        let page = page(FixtureDailyUsage(UsagePreview.history(.recent, today: today)))
        _ = try await host(page)
        try await until { page.overview != nil }
        let since = UsageDates.adding(-39, to: today)
        XCTAssertEqual(page.activityGrid.days.first?.date, since)
        XCTAssertTrue(page.shownTexts[1].hasSuffix(" tokens since \(Strings.Usage.activity(1, since: since).components(separatedBy: " since ").last ?? "")"), page.shownTexts[1])
        XCTAssertEqual(page.activityGrid.layout.offset, UsageDates.weekday(since), "the first column starts on the first day's weekday")
    }

    func testNoRouteMeansNoGridAndIsNotAskedAgain() async throws {
        let daily = ScriptedDaily([.unsupported])
        let page = page(daily)
        _ = try await host(page)
        try await until { page.overview != nil && !page.isReading }
        XCTAssertNil(page.overview?.activity)
        XCTAssertFalse(page.shownTexts.contains("Activity"))
        XCTAssertEqual(page.shownSections.map(\.name), ["Claude", "Codex"], "plans and models still show")
        XCTAssertEqual(page.accountView("claude-cli")?.strip.isHidden, true, "no strips either")
        page.read()
        try await until { !page.isReading }
        let asked = await daily.asked
        XCTAssertEqual(asked, 1)
    }

    func testAFailedReadKeepsWhatWasShown() async throws {
        let daily = ScriptedDaily([UsagePreview.history(.year, today: today), .failed])
        let page = page(daily)
        _ = try await host(page)
        try await until { page.overview?.activity != nil && !page.isReading }
        page.read()
        try await until { !page.isReading }
        let asked = await daily.asked
        XCTAssertEqual(asked, 2)
        XCTAssertEqual(page.overview?.activity?.days.count, 365)
        XCTAssertTrue(page.shownTexts.contains("Activity"))
    }

    func testNothingAtAllSaysSoWithoutAnError() async throws {
        let page = UsageViewController(reader: FixtureUsageReader(usage: .object([:]), catalog: UsagePreview.catalog), daily: FixtureDailyUsage(.history(nil)))
        _ = try await host(page)
        try await until { page.overview != nil }
        XCTAssertEqual(page.shownTexts, [Strings.Usage.emptyTitle, Strings.Usage.emptyBody])
    }
}
#endif
