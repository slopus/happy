#if canImport(UIKit)
import HappyAnalytics
import HappyCore
import HappyUI
import HappyGuest
import HappyGuestUI
import UIKit

/// The app's entry point. It lives in a library target because xtool builds
/// the app from the `HappyApp` product; the XcodeGen app target compiles
/// this same directory.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        LegacyFonts.registerBundledFonts()
        PushNotifications.shared.install()
        Analytics.shared.reportCrashes()
        // The store's transactions are listened for from the first moment: renewals, approvals, refunds.
        Offers.launch()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.didRegister(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushNotifications.shared.didFail(error)
    }

    /// The `remote-notification` background mode delivers pushes here too.
    /// happy-app runs no background task for them, so there is no data.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        completionHandler(.noData)
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coordinator: AppCoordinator?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let coordinator = AppCoordinator(window: window, context: CompositionRoot.makeContext())
        self.window = window
        self.coordinator = coordinator
        // Each computer that takes it is told this phone's time zone and language.
        let installation = PushNotifications.installationID
        let kind: UserEnvironment.DeviceKind = UIDevice.current.userInterfaceIdiom == .pad ? .tablet : .phone
        coordinator.context.account.agentConnections.environment = UserEnvironmentSource(
            deviceId: { (try? installation.read())?.lowercased() }, current: { .current(kind: kind) })
        coordinator.start()
        // New work's pictures, read now off the main thread, are on screen in its first frame.
        StateSceneView.preload([.clapperBoard, .robot])
        #if DEBUG || HAPPY_FIXTURES
        GymFrameMeter.installIfAsked(in: window)
        ScreenFilm.startIfAsked()
        #endif
        #if DEBUG
        DictationTrial.startIfAsked()
        #endif
        PushNotifications.shared.attach(context: coordinator.context, coordinator: coordinator)
        if let response = connectionOptions.notificationResponse {
            PushNotifications.shared.handle(response)
        }
        for context in connectionOptions.urlContexts {
            open(context.url)
        }
        for activity in connectionOptions.userActivities { open(activity) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(context.url)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) { open(userActivity) }

    private func open(_ activity: NSUserActivity) {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL,
              GuestInvitation(url: url) != nil || CloudInvite(url: url) != nil else { return }
        open(url)
    }

    private func open(_ url: URL) {
        guard GuestInvitation(url: url) != nil, let root = window?.rootViewController else {
            coordinator?.open(url)
            return
        }
        let chat: GuestChatViewController
        var presenter = root
        while let presented = presenter.presentedViewController { presenter = presented }
        if let existing = presenter as? GuestChatViewController { chat = existing }
        else {
            chat = GuestChatViewController()
            presenter.present(chat, animated: true)
        }
        chat.open(url)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        Analytics.shared.appBecameActive()
        coordinator?.appStateChanged(active: true)
        activeGuest?.setActive(true)
        PushNotifications.shared.appBecameActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // The last flush gets the time a background task gives it.
        let task = UIApplication.shared.beginBackgroundTask(withName: "happy.analytics")
        Analytics.shared.appEnteredBackground {
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
        coordinator?.appStateChanged(active: false)
        activeGuest?.setActive(false)
    }

    private var activeGuest: GuestChatViewController? {
        var controller = window?.rootViewController
        while let current = controller {
            if let guest = current as? GuestChatViewController { return guest }
            controller = current.presentedViewController
        }
        return nil
    }
}
#endif
