import Foundation

/// The three builds the RN app ships, with the same bundle ids
/// (packages/happy-app/app.config.js), so the native app replaces the RN
/// app in place and keeps its Keychain items, push tokens and links.
public enum AppVariant: String, Sendable, CaseIterable {
    case development
    case preview
    case production

    /// Info.plist key the build writes the variant into (see project.yml).
    public static let infoPlistKey = "HappyAppVariant"

    public var bundleIdentifier: String {
        switch self {
        case .development: return "com.slopus.happy.dev"
        case .preview: return "com.slopus.happy.preview"
        case .production: return "com.ex3ndr.happy"
        }
    }

    public var displayName: String {
        switch self {
        case .development: return "Happy v2 (dev)"
        case .preview: return "Happy v2 (preview)"
        case .production: return "Happy v2"
        }
    }

    /// Reads the variant from the bundle: the explicit Info.plist key first,
    /// then the bundle id, then development.
    public static func current(bundle: Bundle = .main) -> AppVariant {
        if let raw = bundle.object(forInfoDictionaryKey: infoPlistKey) as? String, let variant = AppVariant(rawValue: raw) {
            return variant
        }
        if let id = bundle.bundleIdentifier, let variant = allCases.first(where: { $0.bundleIdentifier == id }) {
            return variant
        }
        return .development
    }
}

/// `X-Happy-Client`, e.g. `ios/2026.10.1`. The server uses it for metrics
/// and compatibility decisions.
public enum HappyClientID {
    public static func make(version: String) -> String {
        "ios/\(version)"
    }

    public static func current(bundle: Bundle = .main) -> String {
        make(version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0")
    }
}
