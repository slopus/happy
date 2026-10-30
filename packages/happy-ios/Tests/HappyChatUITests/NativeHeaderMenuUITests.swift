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

    func testWideCodeKeepsHorizontalMotionAndAllowsTheNativeEdgePop() throws {
        continueAfterFailure = false
        _ = skipsQuiescence
        defer { XCUIDevice.shared.orientation = .portrait }
        for (name, orientation) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft)] {
            for keyboardUp in [false, true] {
                XCUIDevice.shared.orientation = orientation
                let app = XCUIApplication()
                app.launchArguments = ["-fixture", "markdown", "-qa-wide-code", "-composerKeyboardProbe"]
                app.launch()
                let editor = app.textViews.firstMatch
                XCTAssertTrue(editor.waitForExistence(timeout: 15))
                if keyboardUp {
                    editor.tap()
                    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
                }
                func scroller() throws -> [String: Any] {
                    let probe = app.otherElements["composer-keyboard-probe"]
                    XCTAssertTrue(probe.waitForExistence(timeout: 5))
                    for _ in 0..<40 {
                        let value = try XCTUnwrap(probe.value as? String)
                        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
                        if let scroll = (state["horizontalScrollers"] as? [[String: Any]])?.first(where: { $0["class"] as? String == "ChatScrollerView" }) { return scroll }
                        Thread.sleep(forTimeInterval: 0.1)
                    }
                    XCTFail("no visible, genuinely overflowing code scroller")
                    return [:]
                }
                let before = try scroller()
                let frame = try XCTUnwrap(before["frame"] as? [Double])
                let content = try XCTUnwrap(before["contentSize"] as? [Double])
                let bounds = try XCTUnwrap(before["bounds"] as? [Double])
                XCTAssertGreaterThan(content[0], bounds[2] + 1)
                let initialOffset = try XCTUnwrap(before["offset"] as? [Double])[0]
                let left = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame[0] + frame[2] * 0.25, dy: frame[1] + frame[3] / 2))
                let right = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame[0] + frame[2] * 0.75, dy: frame[1] + frame[3] / 2))
                right.press(forDuration: 0.05, thenDragTo: left, withVelocity: .slow, thenHoldForDuration: 0.3)
                Thread.sleep(forTimeInterval: 0.5)
                let afterLeft = try scroller()
                let leftOffset = try XCTUnwrap(afterLeft["offset"] as? [Double])[0]
                XCTAssertGreaterThan(leftOffset, initialOffset + 10)
                left.press(forDuration: 0.05, thenDragTo: right, withVelocity: .slow, thenHoldForDuration: 0.3)
                Thread.sleep(forTimeInterval: 0.5)
                let afterRight = try scroller()
                let rightOffset = try XCTUnwrap(afterRight["offset"] as? [Double])[0]
                XCTAssertLessThan(rightOffset, leftOffset - 10)
                XCTAssertTrue(editor.exists, "the leading horizontal code pan must not become a content pop")
                XCTAssertEqual(app.keyboards.firstMatch.exists, keyboardUp)
                print("WIDE_CODE_NATIVE_POP \(name) keyboard=\(keyboardUp) frame=\(frame) content=\(content) bounds=\(bounds) offset=\(initialOffset),\(leftOffset),\(rightOffset)")
                keep("wide code \(name) keyboard \(keyboardUp)")
                let y = (frame[1] + frame[3] / 2) / app.frame.height
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: y)).press(
                    forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: y)), withVelocity: .slow, thenHoldForDuration: 0.1)
                XCTAssertTrue(app.navigationBars["Chats"].waitForExistence(timeout: 5), "the native edge must still pop over horizontal code")
                app.terminate()
            }
        }
    }
}