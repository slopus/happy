#if canImport(UIKit)
import HappyLayout
import UIKit

/// The call's bar above everything the app shows: a window of its own over
/// the app's, so a sheet, a full-screen viewer or the scanner presented
/// while a call is on still has the bar at the top. It never becomes key
/// (the keyboard and focus stay where they are), takes touches only inside
/// the bar, and sets the status bar white while the bar shows. The system's
/// own windows (permission prompts, Face ID, the App Store's confirmation)
/// are above every app window, so it never covers them.
@MainActor
final class CallBarWindow: UIWindow {
    let host = Host()

    init(scene: UIWindowScene, bar: CallBarView) {
        super.init(windowScene: scene)
        windowLevel = .normal + 1
        backgroundColor = .clear
        rootViewController = host
        host.view.addSubview(bar)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var canBecomeKey: Bool { false }

    /// The bar's touches only; everything else goes to the app below.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), hit !== host.view, hit !== self else { return nil }
        return hit
    }

    final class Host: UIViewController {
        var onLayout: (() -> Void)?
        var shown = false { didSet { if shown != oldValue { setNeedsStatusBarAppearanceUpdate() } } }

        override func loadView() {
            view = UIView()
            view.backgroundColor = .clear
        }

        override var preferredStatusBarStyle: UIStatusBarStyle { shown ? .lightContent : .default }
        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            onLayout?()
        }
    }
}

/// What a screen presented over the app needs so the call's bar doesn't
/// cover its top (`CallPresentations`).
enum CallPresentationClearance: Equatable {
    case none
    /// A full-screen presentation: its safe area grows by this much at the top.
    case inset(CGFloat)
    /// A sheet card: its tallest detent loses this much, so the card starts below the bar.
    case shorter(CGFloat)

    /// `foot` is where the bar ends; `safeTop` the window's own safe area;
    /// `presentedTop` where the presented view starts in the window; a sheet
    /// card on a compact screen sits below the status bar on its own.
    static func of(foot: CGFloat, safeTop: CGFloat, presentedTop: CGFloat, isSheetCard: Bool) -> CallPresentationClearance {
        guard foot > 0 else { return .none }
        if isSheetCard {
            // The tallest card's top sits at the safe area's top or a little below it.
            let overlap = foot + CallPresentations.sheetGap - max(presentedTop, safeTop)
            return overlap > 0 ? .shorter(overlap.rounded(.up)) : .none
        }
        let overlap = foot - max(presentedTop, safeTop)
        return overlap > 0 ? .inset(overlap) : .none
    }
}

/// Keeps what the app presents clear of the call's bar while it shows, and
/// gives back exactly what it took once the bar goes or the screen is
/// dismissed: a full-screen screen's top safe area, a sheet's tallest
/// detent. Only the app's own screens are changed; UIKit's (alerts, share
/// sheets, pickers) are left as UIKit made them, under the bar.
@MainActor
final class CallPresentations {
    nonisolated static let sheetGap: CGFloat = 6

    private struct Applied {
        weak var controller: UIViewController?
        var clearance: CallPresentationClearance
        var detents: [UISheetPresentationController.Detent]?
    }

    private var applied: [ObjectIdentifier: Applied] = [:]
    private var link: CADisplayLink?
    private let root: () -> UIViewController?
    private let foot: () -> CGFloat
    private let echo: CallBarEcho

    init(bar: CallBarView, root: @escaping () -> UIViewController?, foot: @escaping () -> CGFloat) {
        echo = CallBarEcho(bar: bar)
        self.root = root
        self.foot = foot
    }

    /// While the bar shows, each frame looks at what is presented (a few
    /// controllers): one presented later is cleared on its first frame.
    func setActive(_ active: Bool) {
        if active, link == nil {
            let link = CADisplayLink(target: Tick(self), selector: #selector(Tick.fire))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30)
            link.add(to: .main, forMode: .common)
            self.link = link
        } else if !active {
            link?.invalidate()
            link = nil
        }
        update()
    }

    func update() {
        let foot = link == nil ? 0 : foot()
        var present: Set<ObjectIdentifier> = []
        var top: UIViewController?
        var next = root()?.presentedViewController
        while let controller = next {
            next = controller.presentedViewController
            guard Self.isOwn(controller), !controller.isBeingDismissed, let window = controller.view.window else { continue }
            let id = ObjectIdentifier(controller)
            present.insert(id)
            top = controller
            let sheet = controller.sheetPresentationController
            let isCard = sheet != nil && controller.traitCollection.horizontalSizeClass == .compact
                && [.pageSheet, .formSheet, .automatic].contains(controller.modalPresentationStyle)
            let top: CGFloat = if let view = controller.presentationController?.presentedView, !controller.isBeingPresented, !isCard {
                view.convert(view.bounds, to: window).minY
            } else {
                isCard ? window.safeAreaInsets.top : 0
            }
            let wanted = CallPresentationClearance.of(foot: foot, safeTop: window.safeAreaInsets.top, presentedTop: top, isSheetCard: isCard)
            apply(wanted, to: controller, id: id)
        }
        for (id, entry) in applied where !present.contains(id) {
            if let controller = entry.controller { apply(.none, to: controller, id: id) } else { applied[id] = nil }
        }
        // A presentation takes the bar's window out of what VoiceOver reads:
        // its container carries the bar's echo instead, at the bar's place.
        let container = foot > 0 ? top?.presentationController?.containerView : nil
        if echo.superview !== container {
            echo.removeFromSuperview()
            container?.addSubview(echo)
        }
        if let container {
            if container.subviews.last !== echo { container.bringSubviewToFront(echo) }
            echo.frame = container.convert(echo.barFrame, from: nil)
        }
    }

    private func apply(_ wanted: CallPresentationClearance, to controller: UIViewController, id: ObjectIdentifier) {
        let old = applied[id]
        guard old?.clearance ?? .none != wanted else { return }
        // Give back what was taken before taking anything new.
        switch old?.clearance ?? .none {
        case .inset(let value):
            controller.additionalSafeAreaInsets.top -= value
        case .shorter:
            if let sheet = controller.sheetPresentationController, let detents = old?.detents {
                sheet.animateChanges { sheet.detents = detents }
            }
        case .none:
            break
        }
        var entry = Applied(controller: controller, clearance: wanted, detents: nil)
        switch wanted {
        case .inset(let value):
            controller.additionalSafeAreaInsets.top += value
        case .shorter(let value):
            guard let sheet = controller.sheetPresentationController else { break }
            let original = old?.detents ?? sheet.detents
            entry.detents = original
            let large = UISheetPresentationController.Detent.Identifier.large
            let shorter = UISheetPresentationController.Detent.custom(identifier: large) { context in
                max(1, context.maximumDetentValue - value)
            }
            sheet.animateChanges {
                sheet.detents = original.map { $0.identifier == large ? shorter : $0 }
            }
        case .none:
            break
        }
        applied[id] = wanted == .none ? nil : entry
    }

    /// The app's own screens, not UIKit's or another framework's.
    private static func isOwn(_ controller: UIViewController) -> Bool {
        let own = Bundle(for: CallPresentations.self)
        // A stack of the app's screens counts as the app's.
        if let navigation = controller as? UINavigationController, let first = navigation.viewControllers.first {
            return Bundle(for: type(of: first)) == own
        }
        return Bundle(for: type(of: controller)) == own
    }

    /// The display link holds its target; this lets the presentations go.
    @MainActor
    private final class Tick: NSObject {
        weak var owner: CallPresentations?
        init(_ owner: CallPresentations) { self.owner = owner }
        @objc func fire() { owner?.update() }
    }
}
/// The call's bar as VoiceOver finds it under a screen presented over the
/// app, where UIKit no longer reads the bar's own window (touches still go
/// to the bar): one element in the presentation's container exactly where
/// the bar is, saying what the bar says, with mute and end as its actions.
/// It draws nothing and takes no touch.
@MainActor
final class CallBarEcho: UIView {
    private weak var bar: CallBarView?

    init(bar: CallBarView) {
        self.bar = bar
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityIdentifier = "call-bar-echo"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The bar's row in its window's coordinates (the windows share the screen).
    var barFrame: CGRect {
        guard let bar, bar.window != nil else { return .zero }
        return bar.convert(CGRect(x: 0, y: 0, width: bar.bounds.width, height: bar.barHeight), to: nil)
    }

    override var accessibilityLabel: String? {
        get { bar?.spoken.summary }
        set {}
    }

    override var accessibilityTraits: UIAccessibilityTraits {
        get { bar?.spoken.traits ?? .staticText }
        set {}
    }

    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get {
            guard let bar else { return nil }
            let spoken = bar.spoken
            var actions: [UIAccessibilityCustomAction] = []
            if let mute = spoken.mute {
                actions.append(UIAccessibilityCustomAction(name: mute) { [weak bar] _ in bar?.onMute?(); return true })
            }
            if let end = spoken.end {
                actions.append(UIAccessibilityCustomAction(name: end) { [weak bar] _ in bar?.onEnd?(); return true })
            }
            return actions
        }
        set {}
    }

    override func accessibilityActivate() -> Bool {
        bar?.onTap?()
        return true
    }
}
#endif
