import XCTest

final class HomeControllerScrollUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    func testWorkingUpdatesThroughTheFullHomeDuringUIKitInertia() throws {
        for arm in ["off", "working", "connection"] {
            let output = "/Users/steve/Happy/Workspaces/happy/happy-ios/.context/home-controller-\(arm).json"
            let app = XCUIApplication()
            app.launchArguments = ["-fullHomeScroll", "-traceArm", arm, "-traceOutput", output]
            app.launch()
            let probe = app.otherElements["home-controller-probe"]
            let ready = NSPredicate(format: "value == 'ready'")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: probe)], timeout: 25), .completed)
            app.buttons["home-trace-start"].tap()
            let window = app.windows.firstMatch
            let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.72))
            let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.28))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: 1100), thenHoldForDuration: 0)
            Thread.sleep(forTimeInterval: 2.2)
            to.press(forDuration: 0.05, thenDragTo: from, withVelocity: XCUIGestureVelocity(rawValue: 1100), thenHoldForDuration: 0)
            Thread.sleep(forTimeInterval: 2.2)
            app.buttons["home-trace-stop"].tap()
            XCTAssertTrue((probe.value as? String)?.hasPrefix("stopped:") == true)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "full-home-\(arm)"; shot.lifetime = .keepAlways; add(shot)
            print("HOME_CONTROLLER_TRACE \(arm) \(probe.value ?? "") \(output)")
            app.terminate()
        }
    }
}