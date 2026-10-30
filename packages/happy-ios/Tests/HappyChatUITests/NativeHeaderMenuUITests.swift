import XCTest

/// The legacy route uses the same native toolbar menu, with a local fixture
/// so its presentation and keyboard behavior need no external connection.
@MainActor
final class NativeHeaderMenuUITests: XCTestCase {
    func testLegacyToolbarUsesTheNativePermissionMenu() throws {
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-fixture", "long", "-composerKeyboardProbe", "-composerProbeDraft", "Native toolbar keeps this draft.", "-composerProbeRange", "6,10"]
        app.launch()
        defer { app.terminate() }
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        editor.tap()
        editor.typeText("Native toolbar keeps this draft.")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let probe = app.otherElements["composer-keyboard-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        func state() throws -> String {
            let value = try XCTUnwrap(probe.value as? String)
            var current = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
            current.removeValue(forKey: "frames")
            return String(data: try JSONSerialization.data(withJSONObject: current, options: .sortedKeys), encoding: .utf8)!
        }
        let before = try state()
        print("NATIVE_LEGACY_MENU_BEFORE \(before)")
        print("NATIVE_LEGACY_MENU_VIDEO_BEGIN")
        Thread.sleep(forTimeInterval: 2)

        app.buttons["chat-more"].tap()
        let permissions = app.buttons["Permission mode"]
        XCTAssertTrue(permissions.waitForExistence(timeout: 5))
        keep("native legacy toolbar menu")
        print("NATIVE_LEGACY_MENU_OPEN \(try state())")
        permissions.tap()
        let plan = app.buttons["plan"]
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        keep("native legacy permission choices")
        plan.tap()
        XCTAssertTrue(editor.exists)
        XCTAssertEqual(editor.value as? String, "Native toolbar keeps this draft.")
        keep("native legacy permission selected")
        print("NATIVE_LEGACY_MENU_SELECTED \(try state())")
        print("NATIVE_LEGACY_MENU_VIDEO_END")
    }

    private func keep(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        Thread.sleep(forTimeInterval: 0.6)
    }
}