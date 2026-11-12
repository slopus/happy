import Foundation
import HappyCore

// Settings › Usage, as happy-desktop's HappyAgentUsageSettings.tsx and
// UsageActivityGrid.tsx say it, word for word. English only, as desktop's.
extension Strings {
    enum Usage {
        static let title = "Usage"
        static let activity = "Activity"
        /// A service the server doesn't configure.
        static let otherAccounts = "Other accounts"
        static let loading = "Loading usage…"
        static let emptyTitle = "No usage yet"
        static let emptyBody = "Once an account reports its plan or spends tokens, it appears here."
        static let noUsage = "No usage"
        static let gridLabel = "Tokens used each day"
        static func stripLabel(_ account: String) -> String { "Tokens \(account) used each day" }
        static let byModel = "Tokens by model"

        /// "1.4B tokens in the last year", or since the first day known
        /// when that falls inside it.
        static func activity(_ tokens: Int, since: String?) -> String {
            let amount = "\(UsageOverview.compact(tokens)) tokens"
            guard let since, let date = UsageDates.date(since) else { return "\(amount) in the last year" }
            return "\(amount) since \(day(date, "MMM d"))"
        }

        /// "1.4M tokens", "1 token".
        static func tokens(_ count: Int) -> String {
            "\(UsageOverview.compact(count)) \(count == 1 ? "token" : "tokens")"
        }

        /// The callout's day: "Wed, Oct 11, 2023".
        static func callout(_ date: String) -> String {
            UsageDates.date(date).map { day($0, "EEE, MMM d, y") } ?? date
        }

        /// A month's name over the grid: "Nov".
        static func month(_ date: String) -> String {
            UsageDates.date(date).map { day($0, "MMM") } ?? ""
        }

        /// The weekday column's three: Mon, Wed, Fri.
        static let weekdays = ["Mon", "Wed", "Fri"]

        /// "5.7M day · 37.4M week · 134.7M month", leaving out a window with
        /// nothing in it.
        static func modelTotals(_ model: UsageOverview.ModelLine) -> String {
            [(model.day, "day"), (model.week, "week"), (model.month, "month")]
                .filter { $0.0 > 0 }
                .map { "\(UsageOverview.compact($0.0)) \($0.1)" }
                .joined(separator: " · ")
        }

        /// A day named in English, on the UTC calendar that names it.
        private static func day(_ date: Date, _ template: String) -> String {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "UTC")
            formatter.dateFormat = template
            return formatter.string(from: date)
        }
    }
}
