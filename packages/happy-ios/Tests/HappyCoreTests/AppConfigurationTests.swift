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
            XCTAssertEqual(info["CFBundleDisplayName"] as? String, variant.displayName)
            XCTAssertEqual(
                info["NSCameraUsageDescription"] as? String,
                "Allow \(variant.displayName) to access your camera to scan QR codes and share photos with AI."
            )
            let ats = try XCTUnwrap(info["NSAppTransportSecurity"] as? [String: Bool])
            XCTAssertEqual(ats["NSAllowsLocalNetworking"], true)
            // Plain HTTP to any host only in dev and preview, as in app.config.js.
            XCTAssertEqual(ats["NSAllowsArbitraryLoads"] ?? false, variant != .production)
        }
    }

    func testSharedKeysMatch() throws {
        let variantKeys: Set<String> = [
            "HappyAppVariant", "CFBundleDisplayName", "NSCameraUsageDescription",
            "NSLocalNetworkUsageDescription", "NSAppTransportSecurity",
        ]
        func shared(_ info: [String: Any]) throws -> Data {
            let filtered = info.filter { !variantKeys.contains($0.key) }
            return try PropertyListSerialization.data(fromPropertyList: filtered, format: .xml, options: 0)
        }
        let development = try shared(plist(.development))
        XCTAssertEqual(try shared(plist(.preview)), development)
        XCTAssertEqual(try shared(plist(.production)), development)
        let info = try plist(.development)
        XCTAssertEqual(info["CFBundleShortVersionString"] as? String, "2026.10.1")
        let schemes = (info["CFBundleURLTypes"] as? [[String: Any]])?.first?["CFBundleURLSchemes"] as? [String]
        XCTAssertEqual(schemes, ["happy"])
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
