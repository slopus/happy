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
    /// Why the proxy refused tunnels, for the error page.
    var refusals: BrowserRefusals { proxy.refusals }

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

    /// A vault's artifact entry at one version, on an origin of its own
    /// that serves its files and nothing else.
    static func vault(client: AgentClient, surfaceId: String, entryId: String, version: Int, entry: String) async throws -> BrowserPage {
        let host = "v\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()).happy-artifact.invalid"
        let path = entry.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? String($0) }.joined(separator: "/")
        guard let url = URL(string: "http://\(host)/\(path)"), let authority = BrowserPolicy.Authority(url: url) else { throw BrowserError.malformed }
        let proxy = BrowserProxy(client: client, scope: .vaultArtifact(surfaceId: surfaceId, entryId: entryId, version: version, authority: authority))
        do { return BrowserPage(url: url, proxy: proxy, port: try await proxy.start()) }
        catch { await proxy.stop(); throw error }
    }

    static func workspace(client: AgentClient, url: URL, workspaceID: String) async throws -> BrowserPage {
        guard BrowserPolicy.Authority(url: url) != nil else { throw BrowserError.malformed }
        return try await start(url: url, proxy: BrowserProxy(client: client, scope: .workspace(id: workspaceID)))
    }

    /// A live artifact at its version's URL, http or https, through the
    /// artifact's own proxy in the network it was made on. Its store is
    /// this page's alone, and nothing bridges its `/api/*` to the daemon.
    static func live(client: AgentClient, url: URL, artifactID: String) async throws -> BrowserPage {
        guard BrowserPolicy.Authority(url: url) != nil, BrowserNetwork.artifact(artifactID).path != nil else { throw BrowserError.malformed }
        return try await start(url: url, proxy: BrowserProxy(client: client, scope: .liveArtifact(id: artifactID)))
    }

    private static func start(url: URL, proxy: BrowserProxy) async throws -> BrowserPage {
        do { return BrowserPage(url: url, proxy: proxy, port: try await proxy.start()) }
        catch { await proxy.stop(); throw error }
    }

    deinit { let proxy = proxy; Task { await proxy.stop() } }
}
#endif