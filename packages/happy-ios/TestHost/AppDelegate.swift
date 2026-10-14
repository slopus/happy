#if canImport(UIKit)
import UIKit

/// The host of the UIKit tests that need a running application: one window
/// scene with an empty window, nothing else. It links none of the app; the
/// hosted tests bring HappyKit themselves.
@main
@MainActor
final class TestHostAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = TestHostSceneDelegate.self
        return configuration
    }
}

/// The scene's one window, key, over an empty screen.
@MainActor
final class TestHostSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
#endif
