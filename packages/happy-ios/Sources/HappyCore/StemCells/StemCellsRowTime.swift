import Foundation

/// The time at the end of a story row's first line, as Telegram's chat
/// list writes a chat's last message: the clock time today, the weekday
/// within the week, the date before that.
public enum StemCellsRowTime {
    public static func text(_ ms: Double, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) || date > now {
            formatter.dateStyle = .none
            formatter.timeStyle = .short
        } else if let week = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)), date >= week {
            formatter.setLocalizedDateFormatFromTemplate("EEE")
        } else {
            formatter.setLocalizedDateFormatFromTemplate("dMMyy")
        }
        return formatter.string(from: date)
    }
}
