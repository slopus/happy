#if canImport(UIKit)
import UIKit

extension UIViewController {
    /// Header.tsx's `createPlainHeader` title: an RN `<Text>` (16, semibold,
    /// one line) that scales with the text size, uncapped, in a header that
    /// keeps its height, where the bar's own title never scales. Only the
    /// title follows the text size; the screen's rows don't yet. `title`
    /// stays set, for the back button of a screen pushed on top. Empty
    /// shows nothing, as `headerTitle: ''` does.
    func setPlainHeaderTitle(_ text: String) {
        title = text
        let view: NavigationTitleView
        if let shown = navigationItem.titleView as? NavigationTitleView {
            view = shown
        } else {
            view = NavigationTitleView()
            view.traitOverrides.followsTextSize = true
            navigationItem.titleView = view
        }
        let shown = text.isEmpty ? nil : text
        guard view.title != shown || view.frame.size == .zero else { return }
        view.title = shown
        // Fitted to the whole slot, not to the last title's width.
        view.frame.size = view.intrinsicContentSize
    }
}
#endif
