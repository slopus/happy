import Foundation
import HappyCore

// happy-app has no artifact list, so en.ts has none of these words. They
// follow Happy Desktop's artifact words (its sidebar's Artifacts row, the
// artifact viewer's notices) and stay English in every language, as the
// agent screens' others do. Today and Yesterday are happy-app's session
// history's, translated as those are.
extension Strings {
    enum Artifacts {
        static let title = "Artifacts"
        static let search = "Search artifacts"
        static let empty = "No artifacts yet. Ask an agent to make one."
        static let noMatches = "No artifacts match."
        static let unsupported = "This Happy Agent doesn’t keep artifacts."
        static let unavailable = "Artifacts couldn’t be loaded. Check that your computer is on."
        static let loading = "Loading artifacts…"
        static let open = "Open"
        static let copyTitle = "Copy Title"

        /// A kind's name, as a row's subtitle says it.
        nonisolated static func kind(_ type: String, live: Bool = false) -> String {
            if live { return "Live page" }
            switch type {
            case "markdown": return "Document"
            case "html": return "Web page"
            case "image": return "Image"
            case "image_series": return "Images"
            case "video": return "Video"
            case "document": return "File"
            default: return type.isEmpty ? "Artifact" : type.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }

        /// The words a list's derivation says dates in, captured on the
        /// main thread when the screen is built (`localized` is the main
        /// thread's), so the work off it never reads the screens' language.
        struct DateWords: Sendable, Equatable {
            var language: String
            var today: String
            var yesterday: String

            @MainActor
            static var current: DateWords {
                DateWords(language: AppLocalization.language, today: Strings.SessionHistory.today, yesterday: Strings.SessionHistory.yesterday)
            }

            /// A date bucket's heading.
            nonisolated func bucket(_ bucket: DateBucket, now: Date, calendar: Calendar) -> String {
                switch bucket {
                case .today: return today
                case .yesterday: return yesterday
                case .previous7Days: return "Previous 7 Days"
                case .previous30Days: return "Previous 30 Days"
                case .month(let year, let month):
                    let thisYear = calendar.component(.year, from: now)
                    let formatter = formatter(calendar)
                    formatter.setLocalizedDateFormatFromTemplate(year == thisYear ? "MMMM" : "MMMM y")
                    let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)) ?? now
                    return formatter.string(from: date)
                }
            }

            /// When a row last changed, as short as its bucket allows: the
            /// time today and yesterday, the weekday within the week, the
            /// day and month this year, the whole date before.
            nonisolated func time(_ date: Date, now: Date, calendar: Calendar) -> String {
                let formatter = formatter(calendar)
                switch DateBucket.of(date, now: now, calendar: calendar) {
                case .today, .yesterday:
                    formatter.timeStyle = .short
                    formatter.dateStyle = .none
                case .previous7Days:
                    formatter.setLocalizedDateFormatFromTemplate("EEEE")
                default:
                    let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
                    formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
                }
                return formatter.string(from: date)
            }

            private nonisolated func formatter(_ calendar: Calendar) -> DateFormatter {
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: language)
                formatter.calendar = calendar
                formatter.timeZone = calendar.timeZone
                return formatter
            }
        }
    }
}
