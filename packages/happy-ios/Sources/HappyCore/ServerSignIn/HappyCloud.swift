import Foundation
import HappyWire

/// Happy Cloud: one Happy Cloud account (at `auth.happy.engineering`) and
/// the servers it belongs to, each a team server at `<name>.<base>`. Both
/// are compiled into the app. Cloud servers are the only ones added without
/// a scanned code: the app builds their addresses from its own base and a
/// name the accounts service listed, never from anything typed, pasted or
/// opened from a link. A server's installation is recorded from health
/// after sign-in, without a comparison (docs/SERVER-SIGN-IN.md, "Happy
/// Cloud").
public enum HappyCloud {
    /// The domain every cloud server is under. Change it here only.
    public static let base = "happy-clusters.com"
    public static let name = "Happy Cloud"
    /// The accounts service, on its own domain: account sign-in, the
    /// servers API, and every token. Change it here only.
    public static let accounts = "https://auth.happy.engineering"

    /// How a cloud server's own sign-in is described: on the accounts
    /// service, for the server (what `/v0/authentication` advertises). The
    /// app gets its tokens from the accounts API instead of the browser,
    /// and refreshes them here.
    public static func method(server: String) -> OAuthMethod {
        OAuthMethod(id: "jwt", name: name, authorizationUrl: accounts + "/authorize", tokenUrl: accounts + "/token",
                    refreshUrl: accounts + "/token", clientId: "happy", scope: "happy", resource: server + "/")
    }

    /// Offered in development and preview builds only, not yet in the
    /// App Store app.
    public static func isOffered(in variant: AppVariant) -> Bool { variant != .production }

    /// The origin of the server called `name`.
    public static func server(named name: String) -> String { "https://\(name).\(base)" }

    /// The server's name when `server` is a cloud server's origin.
    public static func serverName(_ server: String?) -> String? {
        guard let server, server.hasPrefix("https://"), server.hasSuffix(".\(base)") else { return nil }
        let name = String(server.dropFirst("https://".count).dropLast(base.count + 1))
        return isValidName(name) ? name : nil
    }

    /// How a cloud server's address is shown: like a username, `@acme`.
    /// The domain isn't final, so people never see it.
    public static func handle(_ name: String) -> String { "@" + name }

    /// `server`'s handle when it is a cloud server.
    public static func handle(server: String?) -> String? { serverName(server).map(handle) }

    public static func isCloud(_ server: String?) -> Bool { serverName(server) != nil }

    /// The connection already signed in to `server`, if there is one.
    public static func connection(to server: String, in connections: [AgentConnection]) -> AgentConnection? {
        connections.first { $0.server == server }
    }

    static let reserved: Set<String> = ["accounts", "api", "www", "auth", "admin", "app", "cloud", "mail", "status", "docs", "help"]

    /// A server name the accounts service could accept (ACCOUNTS.md):
    /// 3–32 of `a-z0-9-`, no `-` at either end, not reserved.
    public static func isValidName(_ name: String) -> Bool {
        (3...32).contains(name.count) && !name.hasPrefix("-") && !name.hasSuffix("-") && !reserved.contains(name)
            && name.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}
