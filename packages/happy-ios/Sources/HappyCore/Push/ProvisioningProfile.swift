import Foundation

/// The APNs environment the app was signed for, read from the bundle's
/// `embedded.mobileprovision` exactly as expo-application's
/// `EXProvisioningProfile` does, so the Expo exchange's `development` flag
/// matches what the RN build sends.
public enum ProvisioningProfile {
    private static let prelude = Data(#"<?xml version="1.0" encoding="UTF-8"?>"#.utf8)
    private static let plistEnd = Data("</plist>".utf8)

    /// `Entitlements["aps-environment"]` of the profile's plist, or nil when
    /// the profile can't be read. The profile is a signed CMS envelope; the
    /// plist is the bytes from the XML prelude up to `</plist>`, which runs
    /// to the end of the file when the closing tag is missing, as
    /// `NSScanner` does.
    public static func apsEnvironment(_ profile: Data) -> String? {
        guard let start = profile.range(of: prelude)?.lowerBound else { return nil }
        let end = profile.range(of: plistEnd, in: start..<profile.endIndex)?.lowerBound ?? profile.endIndex
        let plist = profile[start..<end] + plistEnd
        guard let object = try? PropertyListSerialization.propertyList(from: plist, format: nil),
              let dictionary = object as? [String: Any],
              let entitlements = dictionary["Entitlements"] as? [String: Any] else { return nil }
        return entitlements["aps-environment"] as? String
    }

    /// `shouldUseDevelopmentNotificationService`: true only for a profile
    /// that says `development`. No profile (the App Store, the simulator)
    /// or an unreadable one means production. The build configuration plays
    /// no part.
    public static func usesDevelopmentAPNs(_ profile: Data?) -> Bool {
        profile.flatMap(apsEnvironment) == "development"
    }
}
