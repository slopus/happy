#if canImport(UIKit)
import QuartzCore
import UIKit

/// Records when deferred chat content settles. This clock is diagnostic:
/// navigation has already started and never waits for this report.
@MainActor
final class ChatOpening {
    /// The longest a tap waits for a chat's rows.
    static let cap: CFTimeInterval = 0.150
    /// What may land after the first frame, once the cap is hit: the rows,
    /// and the spinner standing in for them.
    static let mayComeLate: Set<String> = ["rows", "placeholder"]
    /// Everything else (the header, the strip, the bars, the composer) is
    /// waited for past the cap, this long at most: the bound on a stalled
    /// read, as the composer's restore has.
    static let limit: CFTimeInterval = 0.400

    /// How an opening went, for the tests and the timing log.
    struct Report: Equatable {
        /// From the start of the opening to its show.
        var elapsed: CFTimeInterval
        /// What was still missing when it was shown: empty unless the cap
        /// was hit, and then only what `mayComeLate` unless the limit was.
        var missing: [String]
        /// When each piece the first look missed came in, from the start.
        var arrivals: [String: CFTimeInterval] = [:]
        var hitCap: Bool { !missing.isEmpty }
    }

    private let started = CACurrentMediaTime()
    private var waiting: Set<String>?
    private var arrivals: [String: CFTimeInterval] = [:]
    private let missing: () -> [String]
    private var show: ((Report) -> Void)?
    private var link: CADisplayLink?

    /// `missing` names what the screen still waits for; `show` runs once.
    init(missing: @escaping () -> [String], show: @escaping (Report) -> Void) {
        self.missing = missing
        self.show = show
        // A piece measured off the main thread lands between frames and
        // says nothing; every frame looks again.
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Looks whether the chat is whole, or out of time, and shows it if so:
    /// every frame, and whenever the screen takes a piece in.
    func check() {
        guard let show else { return }
        let missing = missing()
        let elapsed = CACurrentMediaTime() - started
        for piece in waiting?.subtracting(missing) ?? [] where arrivals[piece] == nil {
            arrivals[piece] = elapsed
        }
        if waiting == nil { waiting = Set(missing) }
        guard Self.shows(missing: missing, elapsed: elapsed) else { return }
        cancel()
        show(Report(elapsed: elapsed, missing: missing, arrivals: arrivals))
    }

    /// Whether a chat still missing `missing` is shown `elapsed` seconds in.
    static func shows(missing: [String], elapsed: CFTimeInterval) -> Bool {
        missing.isEmpty || (elapsed >= cap && missing.allSatisfy(mayComeLate.contains)) || elapsed >= limit
    }

    /// Never shows.
    func cancel() {
        show = nil
        link?.invalidate()
        link = nil
    }

    @objc private func tick() {
        check()
    }

    // MARK: One per stack

    /// The chat being readied for each stack: a newer push or switch on
    /// the stack cancels it, so a second tap never shows two.
    private static let pending = NSMapTable<UINavigationController, ChatViewController>.weakToWeakObjects()

    static func begin(_ chat: ChatViewController, on stack: UINavigationController) {
        cancel(on: stack)
        pending.setObject(chat, forKey: stack)
    }

    static func end(_ chat: ChatViewController, on stack: UINavigationController) {
        if pending.object(forKey: stack) === chat { pending.removeObject(forKey: stack) }
    }

    static func cancel(on stack: UINavigationController) {
        pending.object(forKey: stack)?.cancelOpening()
        pending.removeObject(forKey: stack)
    }

    /// The safe area a screen pushed onto `stack` will have: the stack's,
    /// under its bar.
    static func safeArea(pushedOnto stack: UINavigationController) -> UIEdgeInsets {
        var insets = stack.view.safeAreaInsets
        if !stack.isNavigationBarHidden {
            insets.top = max(insets.top, stack.navigationBar.frame.maxY)
        }
        return insets
    }
}

extension UIViewController {
    /// The traits a screen built before it is in a window is measured with:
    /// those of the screen it will join, held as overrides until it has
    /// joined it (`returnBorrowedTraits`), when they are its own anyway.
    func borrowTraits(from traits: UITraitCollection) {
        traitOverrides.preferredContentSizeCategory = traits.preferredContentSizeCategory
        traitOverrides.displayScale = traits.displayScale
        traitOverrides.userInterfaceStyle = traits.userInterfaceStyle
        traitOverrides.horizontalSizeClass = traits.horizontalSizeClass
        traitOverrides.verticalSizeClass = traits.verticalSizeClass
        traitOverrides.layoutDirection = traits.layoutDirection
        traitOverrides.legibilityWeight = traits.legibilityWeight
        traitOverrides.userInterfaceIdiom = traits.userInterfaceIdiom
        traitOverrides[TabletLayoutTrait.self] = traits.isTabletLayout
        traitOverrides[ZenModeTrait.self] = traits.isZenMode
    }

    func returnBorrowedTraits() {
        for trait: UITrait in [
            UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self, UITraitUserInterfaceStyle.self,
            UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self, UITraitLayoutDirection.self,
            UITraitLegibilityWeight.self, UITraitUserInterfaceIdiom.self, TabletLayoutTrait.self, ZenModeTrait.self,
        ] where traitOverrides.contains(trait) {
            traitOverrides.remove(trait)
        }
    }
}
#endif
