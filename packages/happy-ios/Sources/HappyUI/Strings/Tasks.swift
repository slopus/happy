import Foundation
import HappyCore

// happy-app has no tasks, so en.ts has none of these words. They follow the
// bots' spelled-out English (SessionsList.tsx's "Bots", HomeDock.tsx's
// "Bot", useSessionQuickActions.ts's archive refusal) and Happy Desktop's
// task words (HappyAgentCreateTaskPage.tsx, the sidebar's Tasks), and stay
// English in every language, as those do.
extension Strings {
    public enum Tasks {
        /// The heading over a computer's tasks, under its bots.
        public static let heading = "Tasks"
        /// The dock's third segment.
        public static let composerKind = "Task"
        /// The task card's empty text: its first message names it.
        public static let placeholder = "What should this task do?"
        /// VoiceOver for the task card's primary button.
        public static let create = "Create task"
        /// Swipe and menu: out of this person's list, the task goes on.
        public static let leave = "Leave task"
        /// Menu and session info, for the people allowed to.
        public static let archive = "Archive task"
        public static let failedToLeave = "Failed to leave task"
        /// A task's archive when its machine can't be reached.
        public static let needsMachine = SessionDetailActions.taskArchiveMessage
        /// Leaving it when its machine can't be reached.
        public static let leaveNeedsMachine = SessionDetailActions.taskLeaveMessage
    }
}

extension Strings.Home {
    /// A heading of the project list: "Bots", "Tasks" or "Projects".
    public static func section(_ label: ProjectHomeRow.SectionLabel) -> String {
        switch label {
        case .bots: bots
        case .tasks: Strings.Tasks.heading
        case .projects: projects
        }
    }

    /// A segment of the dock's Session | Bot | Task.
    public static func composerKind(_ kind: HomeDockKind) -> String {
        switch kind {
        case .session: composerSession
        case .bot: composerBot
        case .task: Strings.Tasks.composerKind
        }
    }
}
