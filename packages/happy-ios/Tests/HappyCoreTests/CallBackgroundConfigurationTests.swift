import Foundation
import XCTest

/// An agent connection's voice call goes on in the background (`audio`)
/// until it is ended; pushes come in the background too
/// (`remote-notification`, `PushConfigurationTests`). Nothing else runs
/// there.
final class CallBackgroundConfigurationTests: XCTestCase {
    let packageDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../..")
        .standardizedFileURL

    func testEveryVariantKeepsACallGoingInTheBackground() throws {
        for name in ["Info-Development", "Info-Preview", "Info-Production"] {
            let data = try Data(contentsOf: packageDirectory.appendingPathComponent("App/\(name).plist"))
            let info = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            XCTAssertEqual(info["UIBackgroundModes"] as? [String], ["audio", "remote-notification"], name)
        }
    }
}
