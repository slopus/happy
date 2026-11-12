import Foundation
import HappyCore
import XCTest

/// The three Info.plists in App/ are plain files that xtool and Xcode read
/// as they are, so their shared keys are kept in step by this test rather
/// than by a generator.
final class AppConfigurationTests: XCTestCase {
    let appDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../App")
        .standardizedFileURL

    func plist(_ variant: AppVariant) throws -> [String: Any] {
        let name = switch variant {
        case .development: "Info-Development.plist"
        case .preview: "Info-Preview.plist"
        case .production: "Info-Production.plist"
        }
        let data = try Data(contentsOf: appDirectory.appendingPathComponent(name))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testVariantKeys() throws {
        for variant in AppVariant.allCases {
            let info = try plist(variant)
            XCTAssertEqual(info["HappyAppVariant"] as? String, variant.rawValue)
            XCTAssertEqual(info["HappyGuestPreviewInvites"] as? Bool ?? false, variant == .preview)
            XCTAssertEqual(info["CFBundleDisplayName"] as? String, variant.displayName)
            XCTAssertEqual(
                info["NSCameraUsageDescription"] as? String,
                "Allow \(variant.displayName) to access your camera to scan QR codes and share photos with AI."
            )
            // The microphone's dictation (`RecordButton`) asks for both.
            XCTAssertNotNil(info["NSMicrophoneUsageDescription"] as? String)
            XCTAssertNotNil(info["NSSpeechRecognitionUsageDescription"] as? String)
            let ats = try XCTUnwrap(info["NSAppTransportSecurity"] as? [String: Bool])
            XCTAssertEqual(ats["NSAllowsLocalNetworking"], true)
            // Plain HTTP to any host only in dev and preview, as in app.config.js.
            XCTAssertEqual(ats["NSAllowsArbitraryLoads"] ?? false, variant != .production)
            XCTAssertEqual(ats["NSAllowsArbitraryLoadsInWebContent"], true)
        }
    }

    func testSharedKeysMatch() throws {
        let variantKeys: Set<String> = [
            "HappyAppVariant", "CFBundleDisplayName", "NSCameraUsageDescription",
            "NSLocalNetworkUsageDescription", "NSAppTransportSecurity",
            "HappyGuestPreviewInvites", "CFBundleVersion",
        ]
        func shared(_ info: [String: Any]) throws -> Data {
            let filtered = info.filter { !variantKeys.contains($0.key) }
            return try PropertyListSerialization.data(fromPropertyList: filtered, format: .xml, options: 0)
        }
        let development = try shared(plist(.development))
        XCTAssertEqual(try shared(plist(.preview)), development)
        XCTAssertEqual(try shared(plist(.production)), development)
        let info = try plist(.development)
        // CalVer YYYY.M.C (month unpadded, counter from 1), written by
        // scripts/native-version.cjs: see AGENTS.md, "Versioning".
        let version = try XCTUnwrap(info["CFBundleShortVersionString"] as? String)
        XCTAssertNotNil(version.wholeMatch(of: /[1-9][0-9]{3}\.([1-9]|1[0-2])\.[1-9][0-9]*/), version)
        let schemes = (info["CFBundleURLTypes"] as? [[String: Any]])?.first?["CFBundleURLSchemes"] as? [String]
        // `happy` also carries the server sign-in's redirect (`OAuthRedirect`).
        XCTAssertEqual(schemes, ["happy"])
        XCTAssertEqual(schemes?.contains(OAuthRedirect.scheme), true)
    }

    /// One version for every variant: the plists' version (kept equal by
    /// `testSharedKeysMatch`) is the projects' only `MARKETING_VERSION`.
    func testEveryVariantSharesTheProjectVersion() throws {
        let packageDirectory = appDirectory.deletingLastPathComponent()
        let version = try XCTUnwrap(plist(.development)["CFBundleShortVersionString"] as? String)
        for spec in ["project.yml", "AppClip/project.yml"] {
            let yml = try String(contentsOf: packageDirectory.appendingPathComponent(spec), encoding: .utf8)
            let settings = yml.components(separatedBy: "\n").filter { $0.contains("MARKETING_VERSION:") }
            XCTAssertEqual(settings.map { $0.trimmingCharacters(in: .whitespaces) }, ["MARKETING_VERSION: \"\(version)\""], spec)
        }
        for variant in AppVariant.allCases {
            XCTAssertEqual(try plist(variant)["CFBundleVersion"] as? String, variant == .production ? "160" : "1")
        }
    }

    /// Continue with Google: every variant names its own iOS client in
    /// project.yml (`HAPPY_GOOGLE_CLIENT`, the one Google made for its
    /// bundle id), and the plists make GIDClientID and its reversed URL
    /// scheme from it, beside `happy`.
    func testEveryVariantHasItsOwnGoogleClient() throws {
        let clients: [(AppVariant, String)] = [
            (.development, "902947412706-3563t62iimaknc7lq6fdhgcgna7eff1l"),
            (.preview, "902947412706-0s9bb1000luv6d9vkdbau31h2i69gad0"),
            (.production, "902947412706-3a9fl74rsj3566r0a9i2310mgeu1qd09"),
        ]
        let project = try String(contentsOf: appDirectory.deletingLastPathComponent().appendingPathComponent("project.yml"), encoding: .utf8)
        let lines = project.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertEqual(lines.filter { $0.hasPrefix("HAPPY_GOOGLE_CLIENT:") }.count, clients.count)
        for (variant, client) in clients {
            let bundle = try XCTUnwrap(lines.firstIndex(of: "PRODUCT_BUNDLE_IDENTIFIER: \(variant.bundleIdentifier)"), variant.rawValue)
            XCTAssertTrue(lines[bundle..<min(lines.count, bundle + 5)].contains("HAPPY_GOOGLE_CLIENT: \(client)"), variant.rawValue)
            let info = try plist(variant)
            XCTAssertEqual(info["GIDClientID"] as? String, "$(HAPPY_GOOGLE_CLIENT).apps.googleusercontent.com")
            let schemes = (info["CFBundleURLTypes"] as? [[String: Any]])?.compactMap { $0["CFBundleURLSchemes"] as? [String] }
            XCTAssertEqual(schemes, [["happy"], ["com.googleusercontent.apps.$(HAPPY_GOOGLE_CLIENT)"]])
        }
    }

    func testBuildFilesUseTheRNBundleIds() throws {
        let packageDirectory = appDirectory.deletingLastPathComponent()
        let xtool = try String(contentsOf: packageDirectory.appendingPathComponent("xtool.yml"), encoding: .utf8)
        XCTAssertTrue(xtool.contains("bundleID: \(AppVariant.development.bundleIdentifier)"))
        let project = try String(contentsOf: packageDirectory.appendingPathComponent("project.yml"), encoding: .utf8)
        for variant in AppVariant.allCases {
            XCTAssertTrue(project.contains("PRODUCT_BUNDLE_IDENTIFIER: \(variant.bundleIdentifier)"), variant.rawValue)
        }
    }
}
