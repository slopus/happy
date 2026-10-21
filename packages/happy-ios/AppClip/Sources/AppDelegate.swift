import UIKit

@main
final class GuestAppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Guest", sessionRole: session.role)
        configuration.delegateClass = GuestSceneDelegate.self
        return configuration
    }
}

final class GuestSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let chat = GuestChatViewController()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = chat
        self.window = window
        window.makeKeyAndVisible()
        if let url = options.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb })?.webpageURL {
            chat.open(url)
            return
        }
        if let url = options.urlContexts.first?.url { chat.open(url); return }
        #if DEBUG
        if let value = ProcessInfo.processInfo.environment["_XCAppClipURL"], let url = URL(string: value) { chat.open(url); return }
        #endif
        chat.restore()
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) { open(userActivity) }
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for context in contexts { chat.open(context.url) }
    }
    func sceneDidBecomeActive(_ scene: UIScene) { chat.setActive(true) }
    func sceneDidEnterBackground(_ scene: UIScene) { chat.setActive(false) }

    private func open(_ activity: NSUserActivity) {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL else { return }
        chat.open(url)
    }
}