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
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let probe = app.otherElements["composer-keyboard-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        let before = try XCTUnwrap(probe.value as? String)
        print("NATIVE_LEGACY_MENU_BEFORE \(before)")
        print("NATIVE_LEGACY_MENU_VIDEO_BEGIN")
        Thread.sleep(forTimeInterval: 2)

        app.buttons["chat-more"].tap()
        let permissions = app.buttons["Permission mode"]
        XCTAssertTrue(permissions.waitForExistence(timeout: 5))
        keep("native legacy toolbar menu")
        print("NATIVE_LEGACY_MENU_OPEN \(probe.value as? String ?? "")")
        permissions.tap()
        let plan = app.buttons["plan"]
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        keep("native legacy permission choices")
        plan.tap()
        XCTAssertTrue(editor.exists)
        XCTAssertEqual(editor.value as? String, "Native toolbar keeps this draft.")
        keep("native legacy permission selected")
        print("NATIVE_LEGACY_MENU_SELECTED \(probe.value as? String ?? "")")
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