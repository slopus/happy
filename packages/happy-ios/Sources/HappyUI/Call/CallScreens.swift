#if canImport(UIKit)
import HappyCore
import UIKit

/// The screen moves a call's tools make, whatever its account is: opening a
/// conversation, back and home, as the person would, the control they would
/// tap pressed first (`VoiceTouch`). Agent connections
/// (`SessionCallTargets`) and Happy accounts (`LegacyCallTargets`) alike.
@MainActor
enum CallScreens {
    /// Where opening a conversation puts its screen: the main panel's root
    /// beside an empty panel, else in place of a conversation on top and
    /// over anything else. Returns once it has slid in, so the screen
    /// saying so comes before the next step does, never after it.
    static func place(_ chat: UIViewController, in shell: ShellViewController, isConversation: (UIViewController) -> Bool) async {
        let navigation: UINavigationController = shell.isExpanded ? shell.main : shell.phone
        if shell.isExpanded, navigation.viewControllers.allSatisfy({ $0 === shell.placeholder }) {
            shell.showInMain(chat, animated: true)
        } else {
            // In place of a conversation on top; over anything else, which stays.
            let stack = CallNavigation.opening(chat, over: navigation.viewControllers, isConversation: isConversation)
            navigation.setViewControllers(stack, animated: true)
        }
        await settle(chat.navigationController?.transitionCoordinator)
    }

    /// Back, as the person would: a sheet's own stack first, else what is
    /// presented closes, else the top screen goes. An alert waits for the
    /// person: the call never answers one. No shell: the call has ended.
    static func back(in shell: ShellViewController?) async -> CallScreenMove {
        guard let shell else { return .refused("The call has ended.") }
        guard !Task.isCancelled else { return .refused("No answer in time.") }
        if let presented = presented(over: shell) {
            if presented is UIAlertController { return .refused("An alert is open; the person answers it in the app.") }
            if let control = backControl(in: shell) { await VoiceTouch.play(control) }
            if let sheet = presented as? UINavigationController, sheet.viewControllers.count > 1 {
                sheet.popViewController(animated: true)
                await settle(sheet.transitionCoordinator)
            } else {
                await withCheckedContinuation { done in presented.dismiss(animated: true) { done.resume() } }
            }
            return .moved(atHome: Self.presented(over: shell) == nil && shell.stack.count == 1)
        }
        let stack = shell.stack
        guard stack.count > 1 else { return .refused("This is home; there is nothing to go back to.") }
        if let control = backControl(in: shell) { await VoiceTouch.play(control) }
        shell.setStack(Array(shell.stack.dropLast()), animated: true)
        await settle(shell.stackTransition)
        return .moved(atHome: shell.stack.count == 1)
    }

    /// Home, as the root of the stack: whatever is presented closes, and
    /// every screen over it goes.
    static func home(in shell: ShellViewController?) async -> CallScreenMove {
        guard let shell else { return .refused("The call has ended.") }
        guard !Task.isCancelled else { return .refused("No answer in time.") }
        if let presented = presented(over: shell) {
            if presented is UIAlertController { return .refused("An alert is open; the person answers it in the app.") }
            if let control = backControl(in: shell) { await VoiceTouch.play(control) }
            await withCheckedContinuation { done in shell.dismiss(animated: true) { done.resume() } }
        } else if shell.stack.count > 1, let control = backControl(in: shell) {
            await VoiceTouch.play(control)
        }
        let stack = shell.stack
        if stack.count > 1, let root = stack.first {
            shell.setStack([root], animated: true)
            await settle(shell.stackTransition)
        }
        return .moved(atHome: true)
    }

    /// What the person taps to go back (`VoiceTouch`): a sheet's own back
    /// button, else its close, at the leading end where the app puts it;
    /// else the top screen's back button. Nil where there is none to see.
    static func backControl(in shell: ShellViewController) -> VoiceTouch.Mark? {
        let isBack: (UIView) -> Bool = { VoiceTouch.holds($0, "BackButton") }
        if let presented = presented(over: shell) {
            guard let sheet = presented as? UINavigationController ?? presented.navigationController, !sheet.isNavigationBarHidden else { return nil }
            if sheet.viewControllers.count > 1 { return VoiceTouch.glass(in: sheet.navigationBar, where: isBack).map(VoiceTouch.glassMark) }
            guard sheet.topViewController?.navigationItem.leftBarButtonItem != nil else { return nil }
            let leftToRight = sheet.view.effectiveUserInterfaceLayoutDirection == .leftToRight
            let buttons = VoiceTouch.glassButtons(in: sheet.navigationBar).map { ($0, $0.convert($0.bounds, to: nil).midX) }
            let leading = leftToRight ? buttons.min { $0.1 < $1.1 } : buttons.max { $0.1 < $1.1 }
            return leading.map { VoiceTouch.glassMark($0.0) }
        }
        let navigation: UINavigationController = shell.isExpanded ? shell.main : shell.phone
        guard navigation.viewControllers.count > 1 else { return nil }
        return VoiceTouch.glass(in: navigation.navigationBar, where: isBack).map(VoiceTouch.glassMark)
    }

    /// The topmost screen presented over the app, if any. The call's own
    /// bar is a window of its own, never among them.
    static func presented(over shell: ShellViewController) -> UIViewController? {
        var top = shell.presentedViewController
        while let next = top?.presentedViewController { top = next }
        return top.flatMap { $0.isBeingDismissed ? nil : $0 }
    }

    static func settle(_ coordinator: (any UIViewControllerTransitionCoordinator)?) async {
        guard let coordinator else { return }
        await withCheckedContinuation { done in coordinator.animate(alongsideTransition: nil) { _ in done.resume() } }
    }
}

/// What `CallController` asks of a call's account beside its tools:
/// what is on screen, the conversations held for it, the directory as it
/// changes, and each followed conversation's changes.
@MainActor
protocol LiveCallTargets: AnyObject, CallTargets {
    /// A followed conversation changed.
    var onChange: ((CallTargetState) -> Void)? { get set }
    /// The conversation on screen, if one is.
    var focusedNow: String? { get }
    /// The conversations held for the call.
    var following: [String] { get }
    /// The directory as it changes, for the call's context to tell what matters.
    func watchDirectory(_ changed: @escaping ([CallTarget]) -> Void) -> Watch
    /// Ended with its call: nothing is held, opened or sent after.
    func close()
}
#endif
