#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Owns the window's navigation stack and swaps its root when the account
/// signs in or out. Deep links (`happy://terminal?…`) land here too.
@MainActor
public final class AppCoordinator {
    public let window: UIWindow
    public let context: AppContext
    private let navigation = UINavigationController()
    /// The session the root was built for; nil while signed out, unset
    /// before the first state arrives.
    private var shownSession: ObjectIdentifier??

    public init(window: UIWindow, context: AppContext) {
        self.window = window
        self.context = context
    }

    public func start() {
        Self.applyAppearance(to: navigation.navigationBar)
        ThemeController.apply(from: context, to: window)
        window.rootViewController = navigation
        window.tintColor = UIColor(Palette.headerTint)
        window.makeKeyAndVisible()
        context.account.onChange = { [weak self] state in
            self?.show(state)
        }
        // A stored account flips to signed in before restore() starts
        // syncing, so home appears without a flash of Welcome; without one,
        // Welcome appears as soon as restore() finds nothing.
        Task { @MainActor [weak self] in
            guard let account = self?.context.account else { return }
            await account.restore()
            self?.show(account.state)
        }
    }

    /// Foreground/background, for the server's push suppression.
    public func appStateChanged(active: Bool) {
        guard let session = context.account.session else { return }
        Task { await session.sendAppState(active ? "active" : "background") }
    }

    /// Opens a pairing link from outside the app. Asks first: a link can
    /// come from anywhere, and approving it hands a terminal the account.
    @discardableResult
    public func open(_ url: URL) -> Bool {
        let text = url.absoluteString
        guard let link = PairingLink(text), let top = navigation.topViewController else { return false }
        guard context.account.session != nil else {
            Alerts.show(Strings.Common.error, Strings.Modals.failedToConnectTerminal, on: top)
            return true
        }
        let kind: PairingFlow.Kind
        if case .terminal = link { kind = .terminal } else { kind = .account }
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                kind == .terminal ? Strings.Modals.authenticateTerminal : Strings.SettingsAccount.linkNewDevice,
                nil,
                confirmTitle: Strings.Common.continueAction,
                on: top
            )
            guard confirmed, let session = context.account.session else { return }
            let outcome = await PairingFlow.approve(text, expecting: kind, session: session)
            PairingFlow.report(outcome, kind: kind, on: top)
        }
        return true
    }

    /// Swaps the root only when the account changes. While signed in, home
    /// stays the root and swaps its own content, so screens pushed over it
    /// stay put when a computer arrives.
    private func show(_ state: AccountController.State) {
        // Each account keeps its own theme; logout clears it to adaptive.
        ThemeController.apply(from: context, to: window)
        let session: AccountSession?
        if case .signedIn(let value) = state { session = value } else { session = nil }
        let identity = session.map(ObjectIdentifier.init)
        if let shownSession, shownSession == identity { return }
        let animated = shownSession != nil
        shownSession = .some(identity)
        let root: UIViewController = session.map { HomeViewController(context: context, session: $0) }
            ?? WelcomeViewController(context: context)
        navigation.presentedViewController?.dismiss(animated: false)
        navigation.setViewControllers([root], animated: animated)
    }

    static func applyAppearance(to bar: UINavigationBar) {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Palette.groupedBackground)
        appearance.shadowColor = .clear
        appearance.titleTextAttributes = TextStyles.headerTitle.attributes(color: UIColor(Palette.headerTint))
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.compactAppearance = appearance
        bar.tintColor = UIColor(Palette.headerTint)
    }
}
#endif
