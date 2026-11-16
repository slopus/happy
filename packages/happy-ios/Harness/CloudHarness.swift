#if DEBUG
import HappyCore
import HappyUI
import UIKit

/// One of Happy Cloud's screens (`-cloudScreen welcome|servers|create|connecting|email|code`,
/// a name or email typed with `-cloudName`) under the account token in
/// `-cloudToken`, for device screenshots. `-cloudAccounts <origin>` sends
/// the welcome's sign-ins, and the account they make, to a stand-in for
/// the accounts service and the API alike (scripts/cloud-email-mock); on `email`,
/// `-cloudSend` then taps Send code and `-cloudCode <code>` types the code.
@MainActor
final class CloudHarness {
    init(window: UIWindow, arguments: [String]) {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/cloud-harness",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        let context = AppContext(account: account, variant: .development, version: "cloud-harness")
        let http: any HTTPTransport = value("-cloudAccounts").map { MockAccountsTransport(origin: $0) } ?? NoRedirectURLSessionTransport()
        window.rootViewController = CloudScreensPreview.make(context: context, token: value("-cloudToken") ?? "", screen: value("-cloudScreen") ?? "welcome",
                                                             name: value("-cloudName"), http: http, send: arguments.contains("-cloudSend"), code: value("-cloudCode"))
    }
}

/// The accounts service's and the API's requests, both sent to `origin`
/// instead.
private struct MockAccountsTransport: HTTPTransport {
    let origin: String
    let http = NoRedirectURLSessionTransport()

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var request = request
        let url = request.url.absoluteString
        for real in [HappyCloud.accounts, HappyCloud.api] where url.hasPrefix(real) {
            if let moved = URL(string: origin + url.dropFirst(real.count)) { request.url = moved }
            break
        }
        return try await http.send(request)
    }
}
#endif
