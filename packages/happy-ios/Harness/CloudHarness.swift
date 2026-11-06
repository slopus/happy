#if DEBUG
import HappyCore
import HappyUI
import UIKit

/// One of Happy Cloud's screens (`-cloudScreen welcome|servers|create|join|connecting`,
/// a name typed with `-cloudName`) under the account token in
/// `-cloudToken`, for device screenshots.
@MainActor
final class CloudHarness {
    init(window: UIWindow, arguments: [String]) {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/cloud-harness",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        let context = AppContext(account: account, variant: .development, version: "cloud-harness")
        window.rootViewController = CloudScreensPreview.make(context: context, token: value("-cloudToken") ?? "", screen: value("-cloudScreen") ?? "welcome", name: value("-cloudName"))
    }
}
#endif
