import Foundation

/// Which session a tapped notification opens, ported from happy-app's
/// `utils/notificationRouting.ts` and the response handler in
/// `app/_layout.tsx`. Inputs are the Foundation values a notification's
/// `userInfo` holds, so this runs on Linux.
public enum NotificationRouting {
    /// expo-notifications' `content.data` (`NotificationRecords.swift`
    /// `serializedNotificationData`): a remote notification's payload sits
    /// under `body`; a local one's is the whole `userInfo`.
    public static func data(userInfo: [AnyHashable: Any], isRemote: Bool) -> Any? {
        isRemote ? userInfo["body"] as? [String: Any] : userInfo
    }

    /// `getSessionRouteFromNotificationData`: `/session/<encoded id>`, from
    /// `url` when it names a session, otherwise from `sessionId`. A string
    /// payload is parsed as JSON first.
    public static func sessionRoute(fromData data: Any?) -> String? {
        guard let object = normalized(data) else { return nil }
        if let url = object["url"] as? String, let route = sessionRoute(fromURL: url) {
            return route
        }
        guard let sessionId = object["sessionId"] as? String else { return nil }
        let trimmed = trim(sessionId)
        guard !trimmed.isEmpty else { return nil }
        return "/session/" + encodeURIComponent(trimmed)
    }

    /// The id `_layout.tsx` navigates to: the route without `/session/`,
    /// decoded (left as is when it doesn't decode).
    public static func sessionId(fromData data: Any?) -> String? {
        guard let route = sessionRoute(fromData: data) else { return nil }
        let encoded = String(route.dropFirst("/session/".count))
        return decodeURIComponent(encoded) ?? encoded
    }

    /// `normalizeNotificationData` plus the object check: only a dictionary
    /// (after `JSON.parse` for a string) can name a session.
    private static func normalized(_ data: Any?) -> [AnyHashable: Any]? {
        var value = data
        if let string = value as? String {
            // JSON.parse, or the string itself when it isn't JSON.
            value = (try? JSONSerialization.jsonObject(with: Data(string.utf8), options: .fragmentsAllowed)) ?? string
        }
        if let object = value as? [String: Any] { return object }
        return value as? [AnyHashable: Any]
    }

    private static let sessionPattern = try! NSRegularExpression(pattern: "(?:^|/)session/([^/?#]+)")

    /// `getSessionRouteFromUrl`.
    private static func sessionRoute(fromURL url: String) -> String? {
        let trimmedURL = trim(url)
        guard !trimmedURL.isEmpty else { return nil }
        let range = NSRange(trimmedURL.startIndex..., in: trimmedURL)
        guard let match = sessionPattern.firstMatch(in: trimmedURL, range: range),
              let idRange = Range(match.range(at: 1), in: trimmedURL) else { return nil }
        let encoded = String(trimmedURL[idRange])
        let sessionId = trim(decodeURIComponent(encoded) ?? encoded)
        guard !sessionId.isEmpty else { return nil }
        return "/session/" + encodeURIComponent(sessionId)
    }

    private static func trim(_ string: String) -> String {
        string.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// JS `encodeURIComponent`: everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )`.
    private static let uriComponentAllowed = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    static func encodeURIComponent(_ string: String) -> String {
        string.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? string
    }

    /// JS `decodeURIComponent`; nil where it would throw (a malformed escape
    /// or bytes that aren't UTF-8).
    static func decodeURIComponent(_ string: String) -> String? {
        string.removingPercentEncoding
    }
}

/// `handleNotificationResponse`'s gate: each request is handled once (the
/// launch response and the listener can both deliver it), and only the
/// default action, a plain tap, opens anything.
public struct NotificationResponseFilter: Sendable {
    private var handled: Set<String> = []

    public init() {}

    /// Whether to route this response. The identifier is remembered before
    /// the action is checked, as happy-app does, so a dismissal also counts
    /// as handled.
    public mutating func shouldRoute(requestIdentifier: String, isDefaultAction: Bool) -> Bool {
        handled.insert(requestIdentifier).inserted && isDefaultAction
    }
}

/// `Notifications.setNotificationHandler` in `app/_layout.tsx`: in the
/// foreground a push only sets the badge and goes in the list; otherwise it
/// shows in full. Its `shouldShowAlert` is the deprecated union of banner
/// and list, so it isn't a separate flag here.
public struct NotificationPresentation: Equatable, Sendable {
    public var banner: Bool
    public var list: Bool
    public var sound: Bool
    public var badge: Bool

    public init(banner: Bool, list: Bool, sound: Bool, badge: Bool) {
        self.banner = banner
        self.list = list
        self.sound = sound
        self.badge = badge
    }

    /// `isForeground = AppState.currentState === 'active'`, so an inactive
    /// app (Control Center pulled down, a system alert up) shows it in full.
    public static func forApp(active: Bool) -> NotificationPresentation {
        NotificationPresentation(banner: !active, list: true, sound: !active, badge: true)
    }
}
