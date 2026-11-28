import Foundation
import HappyCore

// Who else looks at a conversation or Surface, in its header. English
// only, as the rest of V2 is.
extension Strings {
    public enum Viewers {
        public static let title = "Viewers"
        public static let someone = "Someone"

        /// "4m", on a face that was here minutes ago.
        public static func badge(_ minutes: Int) -> String { "\(minutes)m" }

        /// "Kirill · here now", "Anna · 6 min ago", "Max · Nov 12".
        public static func row(_ name: String, _ when: ViewerTiers.When, now: Date = Date(), calendar: Calendar = .current) -> String {
            "\(name) · \(self.when(when, now: now, calendar: calendar))"
        }

        /// "Anna · editing": a row with its own ending.
        public static func row(_ name: String, _ when: String) -> String { "\(name) · \(when)" }

        /// In a document, someone whose cursor is in it now.
        public static let editingNow = "editing"

        /// "Anna is editing", "Anna and Max are editing".
        public static func editing(_ names: [String]) -> String {
            switch names.count {
            case 0: ""
            case 1: "\(names[0]) is editing"
            default: "\(names.dropLast().joined(separator: ", ")) and \(names.last!) are editing"
            }
        }

        public static func when(_ when: ViewerTiers.When, now: Date = Date(), calendar: Calendar = .current) -> String {
            switch when {
            case .now: return "here now"
            case .minutes(let minutes): return "\(minutes) min ago"
            case .hours(let hours): return "\(hours) h ago"
            case .day(let date):
                let formatter = DateFormatter()
                formatter.calendar = calendar
                formatter.locale = Locale(identifier: "en_US")
                formatter.setLocalizedDateFormatFromTemplate(calendar.isDate(date, equalTo: now, toGranularity: .year) ? "MMMd" : "yMMMd")
                return formatter.string(from: date)
            }
        }

        /// The slot's spoken summary: "2 here now, 3 seen before".
        public static func summary(here: Int, others: Int) -> String {
            switch (here, others) {
            case (0, 0): return "No one else has looked here"
            case (_, 0): return "\(here) here now"
            case (0, _): return "\(others) looked here before"
            default: return "\(here) here now, \(others) before"
            }
        }
    }
}
