#if canImport(UIKit)
import HappyCore
import UIKit

/// How a task's or bot's row is put away, as desktop's sidebar menu offers
/// it: a task is left, and archived too when the computer says the person
/// may (`canArchive`); a bot is archived by someone who manages bots. The
/// Chief of Staff never. Each goes from the list at once through the
/// account's outbox, and comes back with the computer's reason if refused.
@MainActor
enum PuttingAway {
    struct Act {
        var title: String
        var icon: String
        var destructive: Bool
        var id: String
        /// Asked first from a button that isn't a held row's menu.
        var ask: String? = nil
        var run: () -> Void
    }

    static func acts(_ row: Row, session: Session) -> [Act] {
        guard row.kind == .space, !row.isHappy, let targetId = row.targetId else { return [] }
        let engine = session.engine
        switch row.targetKind {
        case "task":
            var acts = [Act(title: Strings.leaveTask, icon: "close", destructive: false, id: "leave-task") {
                Task { await engine.leave(kind: "task", id: targetId) }
            }]
            if row.canArchive {
                acts.append(Act(title: Strings.archiveTask, icon: "archive", destructive: true, id: "archive-task", ask: Strings.archiveTaskAsk) {
                    Task { await engine.archive(kind: "task", id: targetId) }
                })
            }
            return acts
        case "bot":
            guard session.gate.allows(.botsManage) else { return [] }
            return [Act(title: Strings.archiveBot, icon: "archive", destructive: true, id: "archive-bot", ask: Strings.archiveBotAsk) {
                Task { await engine.archive(kind: "bot", id: targetId) }
            }]
        default:
            return []
        }
    }
}
#endif
