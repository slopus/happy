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

    func testOlderIsTheDate() {
        XCTAssertEqual(text(hoursAgo: 24 * 7), "21/10/26")
    }
}
