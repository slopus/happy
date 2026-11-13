#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The mobileApp gate, on the phone: the app is here already, so what the
/// server waits for is this phone's push registration. Turn On
/// Notifications asks iOS, then registers (`CloudPush`), and the server
/// says the gate is done. Turned off for Happy, it opens Settings, and
/// coming back registers quietly (`Session.renewPush`). A build the relay
/// doesn't take offers the App Store's. Skip for Now while optional.
final class OnboardingNotificationsViewController: CloudStageViewController, OnboardingStepScreen {
    private let session: Session
    private let appStore: URL
    let status = CloudStageViewController.bodyLabel("")
    private enum Action { case register, settings, appStore }
    private var action = Action.register

    init(context: AppContext, session: Session, appStore: URL, optional: Bool) {
        self.session = session
        self.appStore = appStore
        super.init(context: context, scene: .owl, title: Strings.CloudOnboarding.notificationsTitle, body: Strings.CloudOnboarding.notificationsBody,
                   primary: Strings.CloudOnboarding.turnOnNotifications, secondary: optional ? Strings.CloudOnboarding.skip : nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-notifications"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.primaryTapped() }
        content.addSubview(status)
    }

    override func contentHeight(width: CGFloat) -> CGFloat { Self.statusHeight(status, width: width) }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { Self.statusRoom }
    override func layoutContent() { status.setLayoutFrame(content.bounds) }

    private func primaryTapped() async {
        switch action {
        case .register: await turnOn()
        case .settings: if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
        case .appStore: await UIApplication.shared.open(appStore)
        }
    }

    func turnOn() async {
        typealias Text = Strings.CloudOnboarding
        say(nil)
        secondary?.isEnabled = false
        defer { secondary?.isEnabled = true }
        guard let push = SettingsHooks.cloudPush else { return show(.appStore, note: Text.notificationsUnsupported) }
        do {
            switch try await push.register(connection: session.accountID, client: session.client, ask: true) {
            case .registered, .current: _ = try? await session.readOnboarding()
            case .denied: show(.settings, note: Text.notificationsOff)
            case .unsupported: show(.appStore, note: Text.notificationsUnsupported)
            }
        } catch {
            say(Text.notificationsFailed)
        }
    }

    private func show(_ action: Action, note: String) {
        typealias Text = Strings.CloudOnboarding
        self.action = action
        primary.title = action == .settings ? Text.openSettings : action == .appStore ? Text.updateAction : Text.turnOnNotifications
        say(note, problem: false)
    }

    func say(_ problem: String?) { say(problem, problem: true) }

    private func say(_ text: String?, problem: Bool) {
        status.string = text ?? ""
        status.textColor = UIColor(problem ? Palette.textDestructive : Palette.startTextSecondary)
        relayout()
    }
}
#endif
