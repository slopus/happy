import Foundation
import HappyCore

// A conversation's detail, opened from its header: its numbers, where it
// sits in the sidebar's tree, and desktop's Activity. English only, as the
// rest of Stem Cells is.
extension Strings.StemCells {
    public static let detailsHint = "Opens its details"
    public static let rename = "Rename"
    public static let started = "Started"
    public static let media = "Media"
    public static let links = "Links"
    public static let showMore = "Show more"
    public static let family = "Family"
    public static let activity = "Activity"
    public static let completed = "Completed"
    public static let expanded = "Expanded"
    public static let collapsed = "Collapsed"
    public static let bot = "Bot"
    public static let task = "Task"
    public static let subtask = "Subtask"
    public static let conversation = "Conversation"
    /// Nothing recorded yet.
    public static let none = "—"

    /// "Today, 3:41 AM", "Yesterday, 9:12 PM", "Mon, 9:12 PM", "Oct 3", "Oct 3, 2025".
    public static func started(_ started: StemCellsDetailFormat.Started) -> String {
        switch started {
        case .today(let date): "Today, \(date.formatted(date: .omitted, time: .shortened))"
        case .yesterday(let date): "Yesterday, \(date.formatted(date: .omitted, time: .shortened))"
        case .weekday(let date): date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        case .thisYear(let date): date.formatted(.dateTime.month(.abbreviated).day())
        case .date(let date): date.formatted(.dateTime.month(.abbreviated).day().year())
        }
    }

    /// A recording in the shared media, for VoiceOver.
    public static let sharedVideo = "Video"

    public static func age(_ age: StemCellsDetailFormat.Age) -> String {
        switch age {
        case .justNow: "Just now"
        case .minutes(let n): "\(n) min"
        case .hours(let n): n == 1 ? "1 hour" : "\(n) hours"
        case .days(let n): n == 1 ? "1 day" : "\(n) days"
        case .months(let n): n == 1 ? "1 month" : "\(n) months"
        case .years(let n): n == 1 ? "1 year" : "\(n) years"
        }
    }

    /// A child's or a terminal's state, as desktop's Activity words it.
    public static func activityStatus(_ status: String, archived: Bool) -> String {
        if archived { return "closed" }
        return switch status {
        case "idle": "done"
        case "thinking": "thinking"
        case "generating_tools", "running_tools": "running tools"
        default: "working"
        }
    }

    public static let terminalRunning = "running"

    /// "1.2M tokens".
    public static func tokenCount(_ count: Int) -> String { "\(StemCellsDetailFormat.tokens(count)) tokens" }
}
