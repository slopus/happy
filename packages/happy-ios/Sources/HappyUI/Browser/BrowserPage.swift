#if canImport(UIKit)
import HappyCore
import Network
import UIKit
import WebKit

/// Owns the proxy's lifetime, separately from the view (inline and fullscreen).
@MainActor
final class BrowserPage {
    let configuration: WKWebViewConfiguration
    let url: URL
    private let proxy: BrowserProxy

    private init(url: URL, proxy: BrowserProxy, port: UInt16) {
        self.url = url; self.proxy = proxy
        configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        var settings = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!))
        settings.allowFailover = false
        settings.applyCredential(username: proxy.username, password: proxy.password)
        configuration.websiteDataStore.proxyConfigurations = [settings]
    }

    static func artifact(client: AgentClient, id: String, version: Int, entry: String) async throws -> BrowserPage {
        let host = "a\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()).happy-artifact.invalid"
        let path = entry.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? String($0) }.joined(separator: "/")
        guard let url = URL(string: "http://\(host)/\(path)"), let authority = BrowserPolicy.Authority(url: url) else { throw BrowserError.malformed }
        let workspaceID = try? await client.browserWorkspace(artifactID: id)
        let proxy = BrowserProxy(client: client, scope: .artifact(id: id, version: version, authority: authority, workspaceID: workspaceID))
        do { return BrowserPage(url: url, proxy: proxy, port: try await proxy.start()) }
        catch { await proxy.stop(); throw error }
    }

    static func workspace(client: AgentClient, url: URL, workspaceID: String, artifactID: String? = nil) async throws -> BrowserPage {
        guard let authority = BrowserPolicy.Authority(url: url) else { throw BrowserError.malformed }
        let scope: BrowserProxy.Scope
        if let artifactID {
            // HTTPS remains end-to-end encrypted. Never MITM it to insert an
            // authenticated API. Old live artifacts must expose an HTTP preview.
            guard url.scheme == "http" else { throw BrowserError.forbidden }
            scope = .liveArtifact(id: artifactID, workspaceID: workspaceID, authority: authority)
        } else { scope = .workspace(id: workspaceID) }
        let proxy = BrowserProxy(client: client, scope: scope)
        do { return BrowserPage(url: url, proxy: proxy, port: try await proxy.start()) }
        catch { await proxy.stop(); throw error }
    }

    deinit { let proxy = proxy; Task { await proxy.stop() } }
}
#endif