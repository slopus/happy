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
    private lazy var navigation = BrowserNavigationController(context: context)
    /// The window's root: the stack alone on an iPhone; on an iPad the
    /// split view, whose columns or compact stack hold it (docs/IPAD.md).
    private lazy var shell = ShellViewController(context: context, phone: navigation)
    /// The session the root was built for; nil while signed out, unset
    /// before the first state arrives.
    private var shownSession: ObjectIdentifier??
    private var shownServerConfirmationID: AccountSummary.ID?
    private var shownAgentConnectionID: String?
    /// A link from outside, waiting for the stored accounts.
    private var pendingLink: String?
    /// An entity or file link from outside, waiting for the stored accounts.
    private var pendingInstanceLink: String?
    /// What an instance link opens once its connection is home.
    private var instanceTarget: (connection: String, link: HappyLink)?
    /// The session a tapped notification named, until a signed-in home can
    /// open it.
    private var notificationSessionID: String?
    private var accountRestored = false
    private var backgrounded = false
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
        ThemeController.apply(from: context, to: window)
        window.rootViewController = shell
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
        // Where a computer is a home of its own, the profile chosen last
        // opens; with none, a paired computer rather than Welcome.
        let v2 = Preference(variant: context.variant)
        context.account.fallsBackToAgentConnection = true
        PairingAnalytics.shared.variant = context.variant
        Task { @MainActor [weak self] in
            guard let account = self?.context.account else { return }
            // The Happy account's filter showed a computer's V2: that
            // computer is home now, from the first screen.
            await account.restore(openingAgentConnection: v2.takeFilterChoice(), preferred: v2.agentConnectionID)
            self?.show(account.state)
            self?.accountRestored = true
            // Only now, with the accounts read, is it known whose subscription it is.
            Offers.shared.follow(account)
            self?.openPendingLink()
            self?.openPendingInstanceLink()
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
        guard let active = account.session, shell.stack.first is LegacyHomeViewController else {
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
                  self.shell.stack.first is LegacyHomeViewController else {
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
                  let home = self.shell.stack.first as? LegacyHomeViewController else { return }
            if let chat = self.shell.topViewController as? LegacyChatViewController, chat.sessionId == sessionId { return }
            self.shell.presentedViewController?.dismiss(animated: false)
            let chat = Screens.make(.session(id: sessionId), context: self.context, session: session)
            self.shell.setStack([home, chat], animated: true)
        }
        // A new root may still be animating in after an account switch.
        if let transition = shell.stackTransition {
            transition.animate(alongsideTransition: nil) { _ in open() }
        } else {
            open()
        }
    }

    /// Foreground/background, for the server's push suppression.
    public func appStateChanged(active: Bool) {
        Task { await context.account.agentConnections.setForeground(active) }
        // Back from the background: what the store and RevenueCat say now (launch asks on its own).
        if active, backgrounded { Offers.shared.foreground() }
        backgrounded = !active
        guard let session = context.account.session else { return }
        Task { await session.sendAppState(active ? "active" : "background") }
    }

    /// Opens a Happy link from outside the app, routed as a scanned code
    /// is (`HappyScan`). One that arrives before the stored accounts are
    /// read waits for them. A relay link asks first: a link can come from
    /// anywhere, and answering it hands a computer an account; an agent's
    /// link asks through its pairing screen.
    @discardableResult
    public func open(_ url: URL) -> Bool {
        // A sign-in's redirect belongs to its browser session, which takes
        // it before iOS opens the app; a stray one opens nothing.
        if OAuthRedirect.isCallback(url) { return true }
        let text = url.absoluteString
        guard HappyCode(text) != .notHappy else {
            // An entity or file link: opened only on the installation it names.
            guard InstanceLinkRoute.route(text, connections: [], active: nil) != .notALink else { return false }
            pendingInstanceLink = text
            openPendingInstanceLink()
            return true
        }
        pendingLink = text
        openPendingLink()
        return true
    }

    /// An entity or file link from outside: on the connection whose
    /// installation it names (`InstanceLinkRoute`), switched to first, and
    /// on no other.
    private func openPendingInstanceLink() {
        guard accountRestored, pendingInstanceLink != nil, shell.topViewController != nil else { return }
        guard clearedForLink(then: { [weak self] in self?.openPendingInstanceLink() }),
              let text = pendingInstanceLink, let top = linkHost else { return }
        pendingInstanceLink = nil
        let connections = context.account.agentConnections
        switch InstanceLinkRoute.route(text, connections: connections.accounts, active: connections.activeID) {
        case .notALink:
            break
        case .notOpened:
            Alerts.show(Strings.InstanceLinks.notOpenedTitle, Strings.InstanceLinks.notOpened, on: top)
        case .unknownInstance:
            Alerts.show(Strings.InstanceLinks.unknownTitle, Strings.InstanceLinks.unknown, on: top)
        case .open(let id, let link):
            instanceTarget = (id, link)
            if case .agentConnection(let shown) = context.account.state, shown.id == id { return openInstanceTarget() }
            let account = context.account
            Task { @MainActor [weak self] in
                do {
                    if !account.showsAgentConnections { await account.setShowsAgentConnections(true) }
                    try await account.switchAccount(to: id)
                } catch {
                    self?.instanceTarget = nil
                    if let top = self?.linkHost { Alerts.show(Strings.InstanceLinks.unknownTitle, error.localizedDescription, on: top) }
                }
            }
        }
    }

    /// The linked entity, pushed over its connection's home once that is
    /// the root. An artifact or a conversation opens; anything else
    /// (a workspace, a file, a service) shows that connection's home.
    private func openInstanceTarget() {
        guard let target = instanceTarget, case .agentConnection(let shown) = context.account.state, shown.id == target.connection,
              shell.stack.first is AgentHomeViewController, let session = Session.session(for: target.connection, context: context) else { return }
        instanceTarget = nil
        shell.presentedViewController?.dismiss(animated: false)
        guard case .reference(let reference) = target.link.target, let navigation = shell.topViewController?.navigationController else { return }
        switch reference.kind {
        case .artifact:
            var artifact = Artifact(id: reference.id, version: reference.version ?? 1, type: "", title: "", followsLatest: reference.version == nil)
            artifact.pinned = reference.version != nil
            navigation.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: true)
        case .agent:
            let row = session.snapshot.allRows.first { ($0.kind == .space || $0.kind == .session) && $0.agentId == reference.id }
            navigation.pushViewController(ChatViewController(session: session, agentId: reference.id, title: row?.label ?? "", spaceId: row?.spaceId, intro: nil), animated: true)
        default:
            break
        }
    }

    private func openPendingLink() {
        guard accountRestored, pendingLink != nil, shell.topViewController != nil else { return }
        guard clearedForLink(then: { [weak self] in self?.openPendingLink() }),
              let text = pendingLink, let top = linkHost else { return }
        pendingLink = nil
        let route = ScanRoute.route(HappyCode(text), intent: .connect, hasAccount: context.account.session != nil, canShareAccount: context.account.sessionIsLegacy)
        Task { @MainActor in
            switch route {
            case .connectComputer, .confirmConnectComputer, .newAccountForComputer, .linkDevice:
                let terminal = if case .linkDevice = route { false } else { true }
                guard await Alerts.confirm(
                    terminal ? Strings.Modals.authenticateTerminal : Strings.SettingsAccount.linkNewDevice,
                    nil,
                    confirmTitle: Strings.Common.continueAction,
                    on: top
                ) else { return }
            case .connectAgent, .signInToServer, .problem:
                break
            }
            await HappyScan.open(text, intent: .connect, context: context, on: top, start: .openedLink)
        }
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
        if accountRestored { Offers.shared.tell(context.account) }
        let identity = session.map(ObjectIdentifier.init)
        let pending = context.account.pendingServerConfirmation
        let agentConnectionID = context.account.agentConnections.activeID
        CallController.shared.connectionDidChange(to: agentConnectionID)
        if let shownSession, shownSession == identity, shownServerConfirmationID == pending?.id, shownAgentConnectionID == agentConnectionID { return }
        let animated = shownSession != nil
        shownSession = .some(identity)
        shownServerConfirmationID = pending?.id
        shownAgentConnectionID = agentConnectionID
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
        // A swipe back under way (from settings, say) ends first.
        if let transition = shell.stackTransition {
            transition.animate(alongsideTransition: nil) { [weak self] _ in self?.install(session: session, pending: pending, animated: animated) }
            return
        }
        let root: UIViewController
        if let direct = context.account.agentConnections.active {
            root = AgentHomeViewController(context: context, id: direct.id)
        } else if let pending {
            root = AccountServerConfirmationViewController(context: context, account: pending)
        } else if let session {
            root = LegacyHomeViewController(context: context, session: session)
        } else {
            // Nothing paired or signed in: the first screen, whose Start
            // scans any code.
            root = StartViewController(context: context)
        }
        // V2' settings stays on top while the profile it chose
        // takes over underneath. Anything presented goes with the old root,
        // and so does settings once a flow pushed over it or presented from
        // it (pairing, signing in, signing out) caused the change.
        let current = shell.stack
        let settings = current.count == 2 ? current.last as? SettingsViewController : nil
        // A confirmation already going counts as gone.
        let presented = shell.presentedViewController.flatMap { $0.isBeingDismissed ? nil : $0 }
        let kept = settings.flatMap { settings in
            presented == nil && (context.account.agentConnections.active != nil || session != nil) ? settings : nil
        }
        shell.presentedViewController?.dismiss(animated: false)
        let stack = [root] + [kept].compactMap { $0 }
        // Beside the sidebar, the whole split dissolves into the new
        // account's: its home in the sidebar, nothing open beside it.
        if animated, kept == nil, current.count == 1 || shell.isExpanded, shell.view.window != nil {
            // Home itself on screen: the new one dissolves in where it is, so
            // the header and the toolbar stay put and only what's in them
            // changes. A push here read as going somewhere, not as switching.
            UIView.transition(with: shell.crossfadeView, duration: Self.rootCrossfade, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                UIView.performWithoutAnimation {
                    self.shell.setStack(stack, animated: false)
                    self.shell.view.layoutIfNeeded()
                }
            }
        } else {
            // Under settings it swaps unseen; from deeper, back to the new home.
            shell.setStack(stack, animated: animated && kept == nil)
            // Unseen, it is still whole: a root under another screen loads
            // its view only once back or the edge swipe starts, so the bar
            // items it sets then (the account switcher, settings) come in
            // after the bar's transition has begun, and only show once it
            // ends. Loaded now, home fills its bar and list while it waits.
            if kept != nil { root.loadViewIfNeeded() }
        }
        NotificationCenter.default.post(name: Self.rootDidChange, object: window)
        openPendingLink()
        openPendingInstanceLink()
        openNotificationSession()
        openInstanceTarget()
    }

    /// Posted, with the window as its object, once an account's screens
    /// are its root. Whatever was shown over the old ones went with them,
    /// so a flow that changed the account says what it did after this.
    static let rootDidChange = Notification.Name("AppCoordinator.rootDidChange")

    /// How long one home takes to dissolve into the next on a switch. A
    /// dissolve is already the reduced-motion form, so it stays.
    static let rootCrossfade: TimeInterval = 0.28

    /// Where a link from outside opens: on top of the window's stack, once
    /// `clearedForLink` has put away anything over it.
    private var linkHost: UIViewController? {
        shell.presentedViewController?.dismiss(animated: false)
        return shell.topViewController
    }

    /// True when nothing is shown over the stack. Otherwise it (a QR sheet,
    /// a scanner, an alert, an open ⋯ menu) is put away, animated, and
    /// `then` runs once it has gone. A menu dismissed without its animation
    /// went on animating after the pairing push had taken its bar button
    /// away, and UIKit stopped the app (SIGTRAP in
    /// `-[_UIContextMenuPresentation dismiss]`, a link arriving while the
    /// install screen's ⋯ was open).
    private func clearedForLink(then: @escaping @MainActor () -> Void) -> Bool {
        guard let presented = shell.presentedViewController else { return true }
        if presented.isBeingDismissed {
            if let coordinator = presented.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { _ in then() }
            } else {
                DispatchQueue.main.async { then() }
            }
            return false
        }
        shell.dismiss(animated: true) { then() }
        return false
    }

    /// The title of happy-app's UIKit headers (react-native-screens 4.22.0
    /// RNSScreenStackHeaderConfig.mm 41, 480-505): `headerTitleStyle`'s
    /// IBMPlexSans-SemiBold at the default 17, made with `scaleMultiplier`
    /// 1, so it never scales; a font and a colour, nothing more. Screens
    /// with happy-app's own header (Header.tsx, OnboardingHeader) draw a
    /// 16pt title view instead.
    static var nativeTitleAttributes: [NSAttributedString.Key: Any] {
        [
            .font: LegacyFonts.font(.semiBold, size: TextStyles.nativeHeaderTitle.size),
            .foregroundColor: UIColor(Palette.headerTint),
        ]
    }

    /// Clear, over each screen's own background (`HeaderBar`).
    static func applyAppearance(to bar: UINavigationBar) {
        HeaderBar.apply(to: bar)
    }
}
#endif
