import Foundation
import HappyWire

/// Where a settings link (`happy://settings/<page>`, API.md "Settings
/// links") goes on this phone: the app's own page where it has one, a
/// Happy Cloud server's web settings for the rest, and nothing on any
/// other connection. Opening one only navigates. Android maps the pages
/// the same way, but for Sharing and Members, which it has screens for
/// and this app doesn't.
public enum SettingsLinkPlace: Equatable, Sendable {
    /// The connection's Settings.
    case general
    case profile
    /// The computer's Voice page.
    case voice
    /// Happy Cloud's servers.
    case servers
    /// The page in the web app, in the system browser.
    case web(URL)

    /// `page` on a connection to `server`; nil where it's inert.
    public static func place(_ page: HappyLink.SettingsPage, server: String?) -> SettingsLinkPlace? {
        let cloud = HappyCloud.isCloud(server)
        switch page {
        case .general: return .general
        case .account: return .profile
        case .voice: return .voice
        case .servers: return cloud ? .servers : .general
        default: return HappyCloud.webSettings(server: server, page: page).map(SettingsLinkPlace.web)
        }
    }

    /// The page `url` is a settings link to, when it names no other
    /// installation.
    public static func page(_ url: String) -> HappyLink.SettingsPage? {
        guard let link = HappyLink(url), link.instanceId == nil, case .settings(let page) = link.target else { return nil }
        return page
    }

    /// Whether a tap on `url`, a link in a conversation on `server`, opens
    /// anything: a settings page the phone has somewhere to show. The chat
    /// opens no other Happy link.
    public static func opens(_ url: String, server: String?) -> Bool {
        page(url).flatMap { place($0, server: server) } != nil
    }
}
