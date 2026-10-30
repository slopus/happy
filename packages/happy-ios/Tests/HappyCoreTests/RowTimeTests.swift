import Foundation
@testable import HappyCore
import XCTest

/// A story row's time, as desktop's `localAgoTime` tells it.
final class RowTimeTests: XCTestCase {
    private let locale = Locale(identifier: "en_GB")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
    /// Wednesday 28 October 2026, 18:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_793_210_400)

    private func text(minutesAgo minutes: Double, now: Date? = nil) -> String {
        let now = now ?? self.now
        return RowTime.text((now.timeIntervalSince1970 - minutes * 60) * 1000, now: now, calendar: calendar, locale: locale)
    }

    func testWithinTheMinuteIsNow() {
        XCTAssertEqual(text(minutesAgo: 0), "now")
        XCTAssertEqual(text(minutesAgo: 0.98), "now")
        // A clock a little behind the computer's still reads now.
        XCTAssertEqual(text(minutesAgo: -3), "now")
    }

    func testMinutesThenHoursForThePastDay() {
        XCTAssertEqual(text(minutesAgo: 1), "1m")
        XCTAssertEqual(text(minutesAgo: 5), "5m")
        XCTAssertEqual(text(minutesAgo: 59.9), "59m")
        XCTAssertEqual(text(minutesAgo: 60), "1h")
        XCTAssertEqual(text(minutesAgo: 23 * 60 + 59), "23h")
    }

    func testThisWeekIsTheWeekday() {
        XCTAssertEqual(text(minutesAgo: 24 * 60), "Tue")
        XCTAssertEqual(text(minutesAgo: 6 * 24 * 60), "Thu")
    }

    func testOlderIsTheDayAndMonth() {
        XCTAssertEqual(text(minutesAgo: 7 * 24 * 60), "21/10")
        let ms = (now.timeIntervalSince1970 - 7 * 24 * 3600) * 1000
        XCTAssertEqual(RowTime.text(ms, now: now, calendar: calendar, locale: Locale(identifier: "ru_RU")), "21.10")
        XCTAssertEqual(RowTime.text(ms, now: now, calendar: calendar, locale: Locale(identifier: "en_US")), "10/21")
    }

    func testAcrossMidnightADayAgoIsYesterdaysWeekday() {
        let morning = calendar.startOfDay(for: now).addingTimeInterval(3600)
        XCTAssertEqual(text(minutesAgo: 25 * 60, now: morning), "Tue")
        XCTAssertEqual(text(minutesAgo: 49 * 60, now: morning), "Mon")
        XCTAssertEqual(text(minutesAgo: 2 * 60, now: morning), "2h")
    }
}
