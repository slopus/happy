import Foundation

/// The time at the end of a story row's first line, as desktop's
/// `localAgoTime` tells how long ago a conversation last did something:
/// "now" within the minute, minutes and then hours for the past day, the
/// short weekday within the past week, and the short numeric date before
/// that.
public enum RowTime {
    public static func text(_ ms: Double, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let minutes = Int((max(0, now.timeIntervalSince(date)) / 60).rounded(.down))
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 24 * 60 { return "\(minutes / 60)h" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        formatter.setLocalizedDateFormatFromTemplate(days > -7 ? "EEE" : "dM")
        return formatter.string(from: date)
    }
}
