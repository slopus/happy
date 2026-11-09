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

    private init(url: URL, proxy: BrowserProxy, port: UInt16, rules: WKContentRuleList) {
        self.url = url; self.proxy = proxy
        configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(rules)
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
        return try await start(url: url, proxy: BrowserProxy(client: client, scope: .artifact(id: id, version: version, authority: authority, workspaceID: workspaceID)))
    }

    /// A vault's artifact entry at one version, on an origin of its own
    /// that serves its files and nothing else.
    static func vault(client: AgentClient, surfaceId: String, entryId: String, version: Int, entry: String) async throws -> BrowserPage {
        let host = "v\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()).happy-artifact.invalid"
        let path = entry.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? String($0) }.joined(separator: "/")
        guard let url = URL(string: "http://\(host)/\(path)"), let authority = BrowserPolicy.Authority(url: url) else { throw BrowserError.malformed }
        return try await start(url: url, proxy: BrowserProxy(client: client, scope: .vaultArtifact(surfaceId: surfaceId, entryId: entryId, version: version, authority: authority)))
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

    /// A link to the loopback opens on its alias: the computer's loopback.
    private static func start(url: URL, proxy: BrowserProxy) async throws -> BrowserPage {
        do {
            let rules = try await phoneRules()
            return BrowserPage(url: BrowserPolicy.Loopback.alias(url) ?? url, proxy: proxy, port: try await proxy.start(), rules: rules)
        } catch { await proxy.stop(); throw error }
    }

    /// WebKit never proxies the phone's own loopback, so nothing a page
    /// loads may name it, in any spelling WebKit canonicalizes to. A page
    /// opened there is on its alias instead, which these leave alone.
    private static var compiledPhoneRules: WKContentRuleList?
    private static func phoneRules() async throws -> WKContentRuleList {
        if let compiledPhoneRules { return compiledPhoneRules }
        // Content blockers match without `|`: each spelling, then each after a user.
        let hosts = [#"127\.[0-9]+\.[0-9]+\.[0-9]+[:/]"#, #"localhost\.?[:/]"#, #"[^/:]*\.localhost\.?[:/]"#, #"0\.0\.0\.0[:/]"#, #"\[::1?\]"#,
                     #"\[::ffff:127\."#, #"\[::ffff:7f"#, #"\[::ffff:0:0\]"#]
        let rules = hosts.flatMap { [#"^[a-z]+://"# + $0, #"^[a-z]+://[^/]*@"# + $0] }.map { filter in
            #"{"trigger":{"url-filter":""# + filter.replacingOccurrences(of: "\\", with: "\\\\") + #""},"action":{"type":"block"}}"#
        }.joined(separator: ",")
        guard let list = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "happy-phone-loopback", encodedContentRuleList: "[\(rules)]") else { throw BrowserError.unavailable }
        compiledPhoneRules = list
        return list
    }

    deinit { let proxy = proxy; Task { await proxy.stop() } }
}
#endif