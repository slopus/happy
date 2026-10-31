import Foundation
import HappyStore
import HappyWire

/// What the Settings index shows (components/SettingsView.tsx), worked out
/// from the stored profile.
public struct SettingsIndexModel: Equatable, Sendable {
    public enum Header: Equatable, Sendable {
        /// The logotype, until the account has a first name.
        case logo
        /// `profile.firstName` is set: the avatar, the display name and the
        /// GitHub bio. The thumbhash is the uploaded picture's placeholder.
        case profile(id: String, name: String, bio: String?, avatarURL: String?, thumbhash: String?)
    }

    public var header: Header

    public init(profile: AccountProfile?) {
        // SettingsView.tsx branches on firstName, not on the display name, so
        // an account named only through GitHub keeps the logo.
        if let profile, let firstName = profile.firstName, !firstName.isEmpty {
            header = .profile(
                id: profile.id,
                name: profile.displayName ?? firstName,
                bio: profile.bio,
                avatarURL: profile.avatarURL,
                thumbhash: profile.avatar?.thumbhash
            )
        } else {
            header = .logo
        }
    }

    /// The Version row's detail. happy-app shows `version / runtime N`; this
    /// app has no OTA runtime, so it names the variant outside production.
    public static func versionDetail(version: String, variant: AppVariant) -> String {
        variant == .production ? version : "\(version) / \(variant.rawValue)"
    }
}

/// hooks/useMultiClick.ts: fires on the Nth tap when each tap comes within
/// `resetTimeout` of the one before.
public struct MultiClickCounter: Sendable {
    public let requiredClicks: Int
    public let resetTimeout: TimeInterval
    public private(set) var count = 0
    private var lastClick: Date?

    /// Settings › Version: ten taps, two seconds apart at most.
    public init(requiredClicks: Int = 10, resetTimeout: TimeInterval = 2) {
        self.requiredClicks = requiredClicks
        self.resetTimeout = resetTimeout
    }

    /// Counts a tap at `now`; true when it is the one that fires.
    public mutating func click(at now: Date) -> Bool {
        if let lastClick, now.timeIntervalSince(lastClick) >= resetTimeout {
            count = 0
        }
        lastClick = now
        count += 1
        guard count >= requiredClicks else { return false }
        count = 0
        lastClick = nil
        return true
    }
}

/// The system's answer about notifications, as pushRegistration.ts
/// normalises expo-notifications' `PushPermissionInfo`.
public struct PushPermission: Equatable, Sendable {
    public enum Status: String, Sendable {
        case unsupported
        case granted
        case denied
        case undetermined
    }

    public var status: Status
    public var granted: Bool
    public var canAskAgain: Bool

    public init(status: Status, granted: Bool, canAskAgain: Bool) {
        self.status = status
        self.granted = granted
        self.canAskAgain = canAskAgain
    }

    /// expo-notifications on iOS: only a denial stops the prompt; provisional
    /// and ephemeral authorisations count as granted.
    public enum SystemStatus: Sendable {
        case notDetermined
        case denied
        case authorized
        case provisional
        case ephemeral
    }

    public init(system: SystemStatus) {
        switch system {
        case .notDetermined: self.init(status: .undetermined, granted: false, canAskAgain: true)
        case .denied: self.init(status: .denied, granted: false, canAskAgain: false)
        case .authorized, .provisional, .ephemeral: self.init(status: .granted, granted: true, canAskAgain: true)
        }
    }
}

/// The copy of account.tsx's push rows. It is hard-coded English there, not
/// in en.ts, so it lives with the logic that picks it, once: each line cites
/// the line of account.tsx that spells it out.
public enum PushPermissionText {
    /// `formatPushPermissionLabel`; nil while loading.
    public static func label(_ permission: PushPermission?) -> String {
        guard let permission else { return "Loading" }  // account.tsx:38, spelled out
        if permission.status == .unsupported { return "Unavailable" }  // account.tsx:41, spelled out
        if permission.granted { return "Allowed" }  // account.tsx:44, spelled out
        if permission.status == .denied { return "Denied" }  // account.tsx:47, spelled out
        return "Not requested"  // account.tsx:49, spelled out
    }

    /// `formatPushPermissionSubtitle`.
    public static func subtitle(_ permission: PushPermission?) -> String {
        guard let permission else { return "Checking push notification permissions for this device." }  // account.tsx:54, spelled out
        if permission.status == .unsupported { return "Push notification permissions are only managed on mobile devices." }  // account.tsx:57, spelled out
        if permission.granted { return "This device can receive push notifications." }  // account.tsx:60, spelled out
        if permission.canAskAgain { return "The system prompt can still be shown again from the app." }  // account.tsx:63, spelled out
        return "iOS has stopped prompting. Open system settings to enable notifications again."  // account.tsx:65, spelled out
    }

    /// The Request Permission Again row's subtitle.
    public static func requestSubtitle(_ permission: PushPermission?) -> String {
        if permission?.status == .unsupported { return "Push notification permissions are only available on iPhone and Android." }  // account.tsx:520, spelled out
        if permission?.canAskAgain == true { return "Shows the system prompt again if iOS still allows it." }  // account.tsx:522, spelled out
        return "Opens system settings when iOS will not prompt again."  // account.tsx:523, spelled out
    }

    /// The Re-register This Device row's subtitle.
    public static func reregisterSubtitle(currentToken: String?) -> String {
        guard let currentToken else { return "Fetches the current Expo token and registers it again." }  // account.tsx:534, spelled out
        return "Current token \(PushTokenText.fingerprint(currentToken))"  // account.tsx:533, spelled out
    }
}

/// What's New's read marker (changelog/storage.ts). Home's update banner
/// reads it to decide whether there is something new.
public struct ChangelogReadMarker: Sendable {
    public static let key = "changelog-last-viewed-title"
    /// Its own defaults suite: like happy-app's MMKV key, it belongs to the
    /// device, not to an account.
    public static let suiteName = "changelog"

    private let storage: KeyValueStore

    public init(storage: KeyValueStore) {
        self.storage = storage
    }

    public var lastViewedTitle: String {
        storage.string(forKey: Self.key) ?? ""
    }

    public func markViewed(_ title: String) {
        storage.set(title, forKey: Self.key)
    }

    /// `hasUnreadChangelog`.
    public func hasUnread(latestTitle: String) -> Bool {
        !latestTitle.isEmpty && latestTitle != lastViewedTitle
    }
}
