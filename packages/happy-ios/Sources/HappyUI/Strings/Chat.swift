import Foundation
import HappyCore

// The chat's copy. What happy-app reads with `t('key')` is read from the
// screens' catalog under that key (`localized`, main thread only), its
// English copied from _default.ts; what it writes as a literal stays
// English, with the file it comes from. The rows' words are planned off
// the main thread in the language the chat was built in: `ChatWords`.

extension Strings {
    /// textSelection (app/(app)/_layout.tsx's title, text-selection.tsx)
    public enum TextSelection {
        public static var title: String { localized("textSelection.title", "Select Text") }
        public static var noTextProvided: String { localized("textSelection.noTextProvided", "No text provided") }
        public static var textCopied: String { localized("textSelection.textCopied", "Text copied to clipboard") }
    }

    public enum Chat {
        /// common.retry (ChatList.tsx OlderEnd, EmptyMessages.tsx)
        public static var retry: String { localized("common.retry", "Retry") }
        /// common.loadMore (ChatList.tsx OlderEnd, EmptyMessages.tsx)
        public static var loadMore: String { localized("common.loadMore", "Load more") }
        /// pendingChatHandover.ts' fallback when the first message's error
        /// has no words of its own (not in en.ts).
        public static let firstMessageFailed = "Failed to send the first message"
        /// sessionsFilter.worktreeTabs: the header's subtitle over the strip
        /// (SessionView.tsx).
        public static func worktreeTabs(_ count: Int) -> String {
            localized("sessionsFilter.worktreeTabs", ["count": .number(count)], count == 1 ? "1 tab" : "\(count) tabs")
        }
        /// common.copy (LongPressCopyable.tsx; the selection screen's icon
        /// button, which has no label in happy-app, is read as it)
        public static var copy: String { localized("common.copy", "Copy") }
        /// common.copied (MessageView.tsx, not drawn yet: the rows show the tick)
        public static var copied: String { localized("common.copied", "Copied") }
        /// session.inputPlaceholder (SessionView.tsx)
        public static var inputPlaceholder: String { localized("session.inputPlaceholder", "Type a message ...") }
        /// The placeholder for a record this build can't show (not in
        /// happy-app, which drops such records).
        public static func unsupported(_ kind: String) -> String { "This message can't be shown here (\(kind))" }
        /// ChatFooter.tsx (not in en.ts)
        public static let controlledByTerminal = "Permissions shown in terminal only. Reset or send a message to control from app."
        /// session.inactiveArchived (SessionView.tsx)
        public static var inactiveArchived: String { localized("session.inactiveArchived", "This session is inactive.") }
        /// session.resumeFromTerminal (SessionView.tsx)
        public static var resumeFromTerminal: String { localized("session.resumeFromTerminal", "To resume it from the terminal:") }
        /// session.startingChat (PendingChatPlaceholder.tsx)
        public static var startingChat: String { localized("session.startingChat", "Starting a new chat…") }
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

    /// `components.agentGoalBar` (AgentGoalBar.tsx, SessionView.tsx)
    public enum AgentGoal {
        public static var currentGoal: String { localized("components.agentGoalBar.currentGoal", "Current goal") }
        public static func accessibilityLabel(_ goal: String) -> String {
            localized("components.agentGoalBar.accessibilityLabel", ["goal": .text(goal)], "Current goal: \(goal)")
        }
        public static var clearGoal: String { localized("components.agentGoalBar.clearGoal", "Clear goal") }
        public static var stopGoal: String { localized("components.agentGoalBar.stopGoal", "Stop goal") }
        public static var editGoal: String { localized("components.agentGoalBar.editGoal", "Edit goal") }

        public static func action(_ action: SessionGoalAction) -> String {
            switch action {
            case .edit: editGoal
            case .stop: stopGoal
            case .clear: clearGoal
            }
        }
    }
}
