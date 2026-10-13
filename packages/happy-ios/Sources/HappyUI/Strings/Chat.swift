import Foundation
import HappyCore

// The chat's copy, verbatim from happy-app's en.ts (the key each comes from
// is noted where the name differs).

extension Strings {
    /// textSelection
    public enum TextSelection {
        public static let title = "Select Text"
        public static let noTextProvided = "No text provided"
        public static let textCopied = "Text copied to clipboard"
    }

    public enum Chat {
        /// common.retry
        public static let retry = "Retry"
        /// common.loadMore
        public static let loadMore = "Load more"
        /// common.copy
        public static let copy = "Copy"
        /// common.copied
        public static let copied = "Copied"
        /// session.inputPlaceholder
        public static let inputPlaceholder = "Type a message ..."
        /// The placeholder for a record this build can't show (not in
        /// happy-app, which drops such records).
        public static func unsupported(_ kind: String) -> String { "This message can't be shown here (\(kind))" }
        /// ChatFooter.tsx (not in en.ts)
        public static let controlledByTerminal = "Permissions shown in terminal only. Reset or send a message to control from app."
        /// session.inactiveArchived
        public static let inactiveArchived = "This session is inactive."
        /// session.resumeFromTerminal
        public static let resumeFromTerminal = "To resume it from the terminal:"
        /// session.startingChat
        public static let startingChat = "Starting a new chat…"
        /// EmptyMessages.tsx (not in en.ts)
        public static let noMessages = "No messages yet"
        /// EmptyMessages.tsx (not in en.ts)
        public static func created(_ time: String) -> String { "Created \(time)" }
        /// RigActivityBar.tsx (not in en.ts): "2 agents", "1 +3 queued tasks".
        public static func rigActivity(_ indicator: RigActivityIndicator) -> String {
            let label = switch indicator.kind {
            case .subagents: "agents"
            case .workflows: "workflows"
            case .processes: "processes"
            case .tasks: "tasks"
            }
            return "\(indicator.count)\(indicator.queued > 0 ? " +\(indicator.queued) queued" : "") \(label)"
        }
        /// EmptyMessages.tsx `formatRelativeTime`: time.justNow,
        /// time.minutesAgo, time.hoursAgo, sessionHistory.daysAgo.
        public static func age(_ age: DuplicateSheetModel.Age) -> String {
            switch age {
            case .justNow: SessionDetail.justNow
            case .minutes(let count): SessionDetail.minutesAgo(count)
            case .hours(let count): SessionDetail.hoursAgo(count)
            case .days(let count): SessionDetail.daysAgo(count)
            }
        }
    }

    /// en.ts `components.agentGoalBar`
    public enum AgentGoal {
        public static let currentGoal = "Current goal"
        public static func accessibilityLabel(_ goal: String) -> String { "Current goal: \(goal)" }
        public static let clearGoal = "Clear goal"
        public static let stopGoal = "Stop goal"
        public static let editGoal = "Edit goal"

        public static func action(_ action: SessionGoalAction) -> String {
            switch action {
            case .edit: editGoal
            case .stop: stopGoal
            case .clear: clearGoal
            }
        }
    }

    /// en.ts `message`
    public enum ChatMessage {
        public static func switchedToMode(_ mode: String) -> String { "Switched to \(mode) mode" }
        public static let unknownEvent = "Unknown event"
        public static func usageLimitUntil(_ time: String) -> String { "Usage limit reached until \(time)" }
        public static let sentAsGoal = "Sent as goal"
        public static let sendsAfterThisTurn = "Sends after this turn"
        public static let sending = "Sending…"
        public static func sendFailed(_ reason: String) -> String { "Not sent: \(reason)" }
        public static let unknownTime = "unknown time"
    }

    /// en.ts `toolGroup`
    public enum ToolGroup {
        public static let ran = "Ran"
        public static let edited = "Edited"
        public static let read = "Read"
        public static let searched = "Searched"
        public static let fetched = "Fetched"
        public static let ranTask = "Ran task"
        public static func workedFor(_ duration: String) -> String { "Worked \(duration)" }
        public static let hide = "Hide"

        public static let words = ToolActionWords(ran: ran, edited: edited, read: read, searched: searched, fetched: fetched, ranTask: ranTask)
    }

    /// en.ts `markdown`
    public enum Markdown {
        public static let codeCopied = "Code copied"
        public static let copyFailed = "Failed to copy"
        public static let mermaidRenderFailed = "Failed to render mermaid diagram"
    }
}
