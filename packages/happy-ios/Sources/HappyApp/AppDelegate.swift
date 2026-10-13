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
        return true
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
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        coordinator?.appStateChanged(active: false)
    }
}
#endif
