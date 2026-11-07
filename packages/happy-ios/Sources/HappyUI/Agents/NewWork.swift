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

/// New work's screen, as home's compose and a conversation's compose both
/// open it: the empty conversation, named "New", with what it will be
/// (Task or Bot, and a name) in its middle (`NewWorkPanel`), the keyboard
/// coming up with it, or after the first pick when it opens on the "+"
/// sheet. Nothing is made until its first message, which makes the task or
/// bot in place (`NewTask`).
@MainActor
enum NewWork {
    /// `prefill` is an ask typed in for the person, unsent (`ChatPrefill`);
    /// `saying`, words said into home's microphone, sent as it opens.
    static func chat(_ session: Session, task: NewTask, library: Bool = false, prefill: ChatPrefill? = nil, saying: String? = nil) -> ChatViewController {
        let chat = ChatViewController(session: session, agentId: task.agentId, title: Strings.untitled, spaceId: nil, intro: nil, newTask: task, prefill: prefill, saying: saying)
        chat.focusesOnOpen = !library && saying == nil
        chat.focusesAfterPick = library
        return chat
    }
}
#endif
