#if canImport(UIKit)
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
        Fonts.registerBundledFonts()
        PushNotifications.shared.install()
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
        coordinator.start()
        #if DEBUG || HAPPY_FIXTURES
        GymFrameMeter.installIfAsked(in: window)
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
              GuestInvitation(url: url) != nil else { return }
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
        coordinator?.appStateChanged(active: true)
        activeGuest?.setActive(true)
        PushNotifications.shared.appBecameActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
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
