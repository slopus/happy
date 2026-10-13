import Foundation
import HappyCore
import XCTest

/// What the RN app's expo-notifications config plugin adds to every variant
/// (`withNotificationsIOS`, `enableBackgroundRemoteNotifications: true`):
/// `aps-environment` "development" in the entitlements and the
/// `remote-notification` background mode.
final class PushConfigurationTests: XCTestCase {
    let packageDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../..")
        .standardizedFileURL

    func plist(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: packageDirectory.appendingPathComponent(path))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testEveryVariantHasTheRemoteNotificationBackgroundMode() throws {
        for name in ["Info-Development", "Info-Preview", "Info-Production"] {
            XCTAssertEqual(try plist("App/\(name).plist")["UIBackgroundModes"] as? [String], ["remote-notification"], name)
        }
    }

    func testEntitlementsAskForAPNsLikeTheRNApp() throws {
        XCTAssertEqual(try plist("App/Happy.entitlements") as NSDictionary, ["aps-environment": "development"] as NSDictionary)
        let production = try plist("App/Happy-Production.entitlements")
        XCTAssertEqual(production["aps-environment"] as? String, "development")
        XCTAssertEqual(production["com.apple.developer.associated-domains"] as? [String], ["applinks:app.happy.engineering"])
    }

    func testBuildFilesSignWithTheEntitlements() throws {
        let xtool = try String(contentsOf: packageDirectory.appendingPathComponent("xtool.yml"), encoding: .utf8)
        XCTAssertTrue(xtool.contains("entitlementsPath: App/Happy.entitlements"))
        let project = try String(contentsOf: packageDirectory.appendingPathComponent("project.yml"), encoding: .utf8)
        XCTAssertEqual(project.components(separatedBy: "CODE_SIGN_ENTITLEMENTS: App/Happy.entitlements").count - 1, 2)
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS: App/Happy-Production.entitlements"))
    }
}
