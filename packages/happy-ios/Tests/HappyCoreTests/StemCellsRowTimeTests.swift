import Foundation
@testable import HappyCore
import XCTest

/// A story row's time, as Telegram's chat list dates a chat.
final class StemCellsRowTimeTests: XCTestCase {
    private let locale = Locale(identifier: "en_GB")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
    /// Wednesday 28 October 2026, 18:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_793_210_400)

    private func text(hoursAgo hours: Double) -> String {
        StemCellsRowTime.text((now.timeIntervalSince1970 - hours * 3600) * 1000, now: now, calendar: calendar, locale: locale)
    }

    func testTodayIsTheClockTime() {
        XCTAssertEqual(text(hoursAgo: 0), "18:00")
        XCTAssertEqual(text(hoursAgo: 3.75), "14:15")
    }

    func testThisWeekIsTheWeekday() {
        XCTAssertEqual(text(hoursAgo: 24), "Tue")
        XCTAssertEqual(text(hoursAgo: 24 * 6), "Thu")
    }

    func testOlderIsTheDayAndMonth() {
        XCTAssertEqual(text(hoursAgo: 24 * 7), "21/10")
        XCTAssertEqual(StemCellsRowTime.text((now.timeIntervalSince1970 - 24 * 7 * 3600) * 1000, now: now, calendar: calendar, locale: Locale(identifier: "ru_RU")), "21.10")
        XCTAssertEqual(StemCellsRowTime.text((now.timeIntervalSince1970 - 24 * 7 * 3600) * 1000, now: now, calendar: calendar, locale: Locale(identifier: "en_US")), "10/21")
    }

    func testPreviousYearsIncludeTheYear() {
        let date = calendar.date(from: DateComponents(year: 2025, month: 10, day: 21))!
        XCTAssertEqual(StemCellsRowTime.text(date.timeIntervalSince1970 * 1000, now: now, calendar: calendar, locale: locale), "21/10/2025")
    }

    func testYesterdayNeverLooksLikeTodayAcrossMidnight() {
        let midnight = calendar.startOfDay(for: now)
        XCTAssertEqual(StemCellsRowTime.text((midnight.timeIntervalSince1970 - 60) * 1000, now: midnight, calendar: calendar, locale: locale), "Tue")
    }
}
