#if canImport(UIKit)
import HappyCore
import HappyUI
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
        PushNotifications.shared.attach(context: coordinator.context, coordinator: coordinator)
        if let response = connectionOptions.notificationResponse {
            PushNotifications.shared.handle(response)
        }
        for context in connectionOptions.urlContexts {
            coordinator.open(context.url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            coordinator?.open(context.url)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        coordinator?.appStateChanged(active: true)
        PushNotifications.shared.appBecameActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        coordinator?.appStateChanged(active: false)
    }
}
#endif
