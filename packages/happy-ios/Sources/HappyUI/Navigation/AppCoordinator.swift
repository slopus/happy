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
    // Tablet (HappyUI/Tablet): the window's root holds the stack, and the
    // sidebar beside it on a tablet-wide window.
    private lazy var shell = TabletShellViewController(context: context, detail: navigation)
    /// The session the root was built for; nil while signed out, unset
    /// before the first state arrives.
    private var shownSession: ObjectIdentifier??
    private var shownServerConfirmationID: AccountSummary.ID?
    /// The session a tapped notification named, until a signed-in home can
    /// open it.
    private var notificationSessionID: String?
    private var accountRestored = false
    private var switchingForNotification = false
    private var lookingUpNotification = false
    /// Decides the language of the screens about to be built, holding the
    /// window's touches meanwhile; a newer root replaces a pending one.
    private let language: ScreensLanguage

    public init(window: UIWindow, context: AppContext) {
        self.window = window
        self.context = context
        language = ScreensLanguage(holding: window)
    }

    public func start() {
        Self.applyAppearance(to: navigation.navigationBar)
        ThemeController.apply(from: context, to: window)
        window.rootViewController = shell // Tablet: was `navigation`.
        window.tintColor = UIColor(Palette.headerTint)
        window.makeKeyAndVisible()
        context.account.onChange = { [weak self] state in
            self?.show(state)
        }
        // language.tsx reloads the app after a new language; here the
        // screens are built again in it, from the root, as a reload leaves
        // them.
        language.takeChoices { [weak self] changed in self?.languageChosen(changed: changed) }
        // A stored account flips to signed in before restore() starts
        // syncing, so home appears without a flash of Welcome; without one,
        // Welcome appears as soon as restore() finds nothing.
        Task { @MainActor [weak self] in
            guard let account = self?.context.account else { return }
            await account.restore()
            self?.show(account.state)
            self?.accountRestored = true
            self?.openNotificationSession()
        }
    }

    /// Opens the session a tapped notification names (`app/_layout.tsx`
    /// `handleNotificationResponse`, then `navigateToSession`). A session in
    /// another signed-in account's store switches to that account first;
    /// one in no store opens in the active account, as happy-app navigates
    /// regardless. A tap that launched the app waits for the stored account.
    public func openSession(fromNotification sessionId: String) {
        notificationSessionID = sessionId
        openNotificationSession()
    }

    private func openNotificationSession() {
        guard let sessionId = notificationSessionID else { return }
        let account = context.account
        // A root being decided opens it once it is in.
        guard !language.isDeciding else { return }
        guard let active = account.session, navigation.viewControllers.first is HomeViewController else {
            // Signed out once restored: there is nothing to open it in.
            if accountRestored, account.session == nil { notificationSessionID = nil }
            return
        }
        guard !lookingUpNotification else { return }
        lookingUpNotification = true
        Task { @MainActor [weak self] in
            let owner: AccountSummary.ID?
            do { owner = try await account.accountHoldingSession(sessionId) }
            catch { owner = nil } // Keep the active-account fallback on lookup failure.
            guard let self else { return }
            self.lookingUpNotification = false
            guard self.notificationSessionID == sessionId,
                  account.session === active,
                  !self.language.isDeciding,
                  self.navigation.viewControllers.first is HomeViewController else {
                self.openNotificationSession()
                return
            }
            if let owner, owner != active.keys.anonID {
                // restore() holds the account controller through the first sync,
                // so the switch waits for it. show() opens the session once the
                // owner's home is the root.
                guard self.accountRestored, !self.switchingForNotification else { return }
                self.switchingForNotification = true
                Task { @MainActor [weak self] in
                    do {
                        try await account.switchAccount(to: owner)
                    } catch {
                        if self?.notificationSessionID == sessionId {
                            self?.notificationSessionID = nil
                            self?.showNotificationSession(sessionId)
                        }
                    }
                    self?.switchingForNotification = false
                }
                return
            }
            self.notificationSessionID = nil
            self.showNotificationSession(sessionId)
        }
    }

    /// Home, then the chat. Nothing changes when that chat is already on top.
    private func showNotificationSession(_ sessionId: String) {
        let open = { [weak self] in
            guard let self else { return }
            // Another root began meanwhile: it opens the chat once it is in.
            guard !self.language.isDeciding else {
                if self.notificationSessionID == nil { self.notificationSessionID = sessionId }
                return
            }
            guard let session = self.context.account.session,
                  let home = self.navigation.viewControllers.first as? HomeViewController else { return }
            if let chat = self.navigation.topViewController as? ChatViewController, chat.sessionId == sessionId { return }
            self.navigation.presentedViewController?.dismiss(animated: false)
            let chat = Screens.make(.session(id: sessionId), context: self.context, session: session)
            self.navigation.setViewControllers([home, chat], animated: true)
        }
        // A new root may still be animating in after an account switch.
        if let transition = navigation.transitionCoordinator {
            transition.animate(alongsideTransition: nil) { _ in open() }
        } else {
            open()
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
        VoiceCoordinator.shared.accountDidChange(to: session)
        let identity = session.map(ObjectIdentifier.init)
        let pending = context.account.pendingServerConfirmation
        if let shownSession, shownSession == identity, shownServerConfirmationID == pending?.id { return }
        let animated = shownSession != nil
        shownSession = .some(identity)
        shownServerConfirmationID = pending?.id
        requestRoot(session: session, pending: pending, animated: animated)
    }

    /// The account's root in the account's language (text/index.ts at
    /// launch), decided and decoded off the main thread before it is built.
    /// The account's root is installed whatever the decision; in the
    /// language in use when the account's can't be decided.
    private func requestRoot(session: AccountSession?, pending: AccountSummary?, animated: Bool) {
        // Read here, on main; the account's settings are read off it.
        let deviceLanguages = Locale.preferredLanguages
        language.request(
            for: session,
            resolve: { await Self.resolvedLanguage(for: session, deviceLanguages: deviceLanguages) },
            install: { [weak self] in self?.install(session: session, pending: pending, animated: animated) }
        )
    }

    /// The window's screens again, from the root, in the language the
    /// Language page chose; nothing else changes. Only ever for the account
    /// the screens are now: a choice made in another's never gets here
    /// (`ScreensLanguage.choose`).
    private func languageChosen(changed: Bool) {
        guard changed else {
            // A notification's chat waited for this.
            openNotificationSession()
            return
        }
        install(session: context.account.session, pending: context.account.pendingServerConfirmation, animated: false)
    }

    /// The account's `preferredLanguage` and the device's languages, as
    /// text/index.ts resolves them; the device's alone while signed out, or
    /// when the account's settings don't answer within a second.
    private nonisolated static func resolvedLanguage(for session: AccountSession?, deviceLanguages: [String]) async -> String {
        var preferred: String?
        if let settings = session?.settingsFeed {
            preferred = await withTaskGroup(of: String??.self) { group in
                group.addTask {
                    for await snapshot in settings.snapshots() { return .some(AccountSettings(snapshot).preferredLanguage) }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(1))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first ?? nil
            }
        }
        return AppLanguage.resolve(preferred: preferred, deviceLanguages: deviceLanguages)
    }

    private func install(session: AccountSession?, pending: AccountSummary?, animated: Bool) {
        let root: UIViewController
        if let pending {
            root = AccountServerConfirmationViewController(context: context, account: pending)
        } else {
            root = session.map { HomeViewController(context: context, session: $0) }
                ?? WelcomeViewController(context: context)
        }
        navigation.presentedViewController?.dismiss(animated: false)
        navigation.setViewControllers([root], animated: animated)
        shell.rootDidChange() // Tablet: the sidebar follows the account.
        openNotificationSession()
    }

    /// The title of happy-app's UIKit headers (react-native-screens 4.22.0
    /// RNSScreenStackHeaderConfig.mm 41, 480-505): `headerTitleStyle`'s
    /// IBMPlexSans-SemiBold at the default 17, made with `scaleMultiplier`
    /// 1, so it never scales; a font and a colour, nothing more. Screens
    /// with happy-app's own header (Header.tsx, OnboardingHeader) draw a
    /// 16pt title view instead.
    static var nativeTitleAttributes: [NSAttributedString.Key: Any] {
        [
            .font: Fonts.font(.semiBold, size: TextStyles.nativeHeaderTitle.size),
            .foregroundColor: UIColor(Palette.headerTint),
        ]
    }

    static func applyAppearance(to bar: UINavigationBar) {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Palette.groupedBackground)
        appearance.shadowColor = .clear
        appearance.titleTextAttributes = Self.nativeTitleAttributes
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.compactAppearance = appearance
        bar.tintColor = UIColor(Palette.headerTint)
    }
}
#endif
