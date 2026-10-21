#if canImport(UIKit)
import UIKit

extension UIViewController {
    /// Puts `view` in the bar's title slot, drawn at this screen's text
    /// size. UINavigationBar holds the text size its title view inherits
    /// to XXL (its content view's `maximumContentSizeCategory`, iOS 26.5
    /// simulator: 19.76 for a 16 title), where the RN Text in Header.tsx
    /// and OnboardingHeader goes on scaling. A title view's own override
    /// is past the cap, so the view takes this screen's size category as
    /// its own, and again whenever the screen's changes. Once per screen;
    /// a title view set later the same way takes the screen's size too.
    func setScaledTitleView(_ view: UIView) {
        view.traitOverrides.followsTextSize = true
        navigationItem.titleView = view
        applyScreenTextSizeToTitleView()
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (controller: UIViewController, _: UITraitCollection) in
            controller.applyScreenTextSizeToTitleView()
        }
    }

    /// The controller's own traits: in its trait change its view's are
    /// still the old ones. None yet (a screen not on one) leaves the view
    /// what it inherits.
    private func applyScreenTextSizeToTitleView() {
        let category = traitCollection.preferredContentSizeCategory
        guard category != .unspecified, let view = navigationItem.titleView else { return }
        view.traitOverrides.preferredContentSizeCategory = category
    }

    /// Header.tsx's `createPlainHeader` title: an RN `<Text>` (16, semibold,
    /// one line) that scales with the text size, uncapped, in a header that
    /// keeps its height, where the bar's own title never scales. The title
    /// follows the screen's text size, past the bar's XXL cap
    /// (`setScaledTitleView`), even on a screen whose rows don't. `title`
    /// stays set, for the back button of a screen pushed on top. Empty
    /// shows nothing, as `headerTitle: ''` does.
    func setPlainHeaderTitle(_ text: String) {
        title = text
        let view: NavigationTitleView
        if let shown = navigationItem.titleView as? NavigationTitleView {
            view = shown
        } else {
            view = NavigationTitleView()
            setScaledTitleView(view)
        }
        let shown = text.isEmpty ? nil : text
        guard view.title != shown || view.frame.size == .zero else { return }
        view.title = shown
        // Fitted to the whole slot, not to the last title's width.
        view.frame.size = view.intrinsicContentSize
    }
}
#endif
