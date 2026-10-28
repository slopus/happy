import Foundation
import XCTest

final class MacAppConfigurationTests: XCTestCase {
    private let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("../../Mac").standardizedFileURL

    private func read(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testMacPlistHasDesktopLifecycleAndPrivacy() throws {
        let info = try read("Info.plist")
        XCTAssertNil(info["LSRequiresIPhoneOS"])
        XCTAssertNil(info["UIBackgroundModes"])
        XCTAssertNil(info["UIApplicationSceneManifest"])
        XCTAssertEqual(info["NSPrincipalClass"] as? String, "NSApplication")
        XCTAssertEqual(info["NSHighResolutionCapable"] as? Bool, true)
        for key in ["NSLocalNetworkUsageDescription"] {
            XCTAssertFalse(try XCTUnwrap(info[key] as? String).isEmpty, key)
        }
        let ats = try XCTUnwrap(info["NSAppTransportSecurity"] as? [String: Bool])
        XCTAssertEqual(ats["NSAllowsLocalNetworking"], true)
        XCTAssertFalse(ats["NSAllowsArbitraryLoads"] ?? false)
        let schemes = (info["CFBundleURLTypes"] as? [[String: Any]])?.first?["CFBundleURLSchemes"] as? [String]
        XCTAssertEqual(schemes, ["happy"])
    }

    func testSandboxHasOnlyDesktopCapabilities() throws {
        let entitlements = try read("HappyMac.entitlements")
        XCTAssertEqual(Set(entitlements.keys), Set([
            "com.apple.security.app-sandbox", "com.apple.security.network.client",
        ]))
        XCTAssertTrue(entitlements.values.allSatisfy { $0 as? Bool == true })
    }

    func testAppKitTargetDoesNotLinkUIKitProduct() throws {
        let project = try String(contentsOf: directory.appendingPathComponent("../project.yml"), encoding: .utf8)
        let target = try XCTUnwrap(project.components(separatedBy: "  HappyMac:\n").dropFirst().first?.components(separatedBy: "  HappyMacTests:\n").first)
        XCTAssertTrue(target.contains("platform: macOS"))
        XCTAssertTrue(target.contains("SDKROOT: macosx"))
        XCTAssertTrue(target.contains("product: HappyClientKit"))
        XCTAssertFalse(target.contains("product: HappyKit"))
        XCTAssertFalse(target.contains("Sources/HappyApp"))
    }
}