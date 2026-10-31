#if canImport(UIKit)
import HappyCore
import UIKit

/// A screen that brings its own push (as it comes in) and pop (as it goes)
/// with the screen under it; nil leaves UIKit's slide. The stack's delegate
/// asks it.
@MainActor
protocol NavigationTransitionProviding: AnyObject {
    func navigationTransition(_ operation: UINavigationController.Operation, other: UIViewController) -> UIViewControllerAnimatedTransitioning?
}

/// A new task's screen, as home's compose and a conversation's compose
/// both open it: the empty conversation, named "New" under its seedling,
/// the keyboard coming up with it, or after the first pick when it opens
/// on the "+" sheet. Nothing is made until its first message, which makes
/// the task in place (`NewTask`).
@MainActor
enum NewWork {
    /// `prefill` is an ask typed in for the person, unsent (`ChatPrefill`).
    static func chat(_ session: Session, task: NewTask, library: Bool = false, prefill: ChatPrefill? = nil) -> ChatViewController {
        let chat = ChatViewController(session: session, agentId: task.agentId, title: Strings.untitled, spaceId: nil, seedling: .seedling(seed: task.identity.taskId), newTask: task, prefill: prefill)
        chat.focusesOnOpen = !library
        chat.focusesAfterPick = library
        return chat
    }
}
#endif
