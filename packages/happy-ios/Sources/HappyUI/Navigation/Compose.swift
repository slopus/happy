#if canImport(UIKit)
import UIKit

/// A screen whose bar has compose: home opens an empty chat over itself,
/// and a chat puts an empty chat in its own place. The bar's button calls
/// `compose()` and nothing else; what it opens is the screen's business.
@MainActor
protocol ComposeHosting: UIViewController {
    func compose()
}

@MainActor
enum ComposeNavigation {
    /// `chat` in place of `current`, which goes: the stack stays as deep,
    /// so Back still leads to what was under `current` (home). UIKit
    /// slides it in as a push, and its own swipe back works as on any
    /// screen.
    static func replace(_ current: UIViewController, with chat: UIViewController) {
        guard let navigation = current.navigationController,
              let index = navigation.viewControllers.firstIndex(of: current) else { return }
        // A screen still coming or going: the last word goes to it.
        guard navigation.transitionCoordinator == nil else { return }
        var stack = Array(navigation.viewControllers.prefix(index))
        stack.append(chat)
        navigation.setViewControllers(stack, animated: true)
    }
}
#endif
