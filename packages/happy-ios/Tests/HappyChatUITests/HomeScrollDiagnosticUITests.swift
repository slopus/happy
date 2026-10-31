import XCTest

@MainActor
final class HomeScrollDiagnosticUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    func testHeldFingerUpdateMatrix() throws { try run(phase: "drag") }
    func testDecelerationUpdateMatrix() throws { try run(phase: "momentum") }
    func testUpdateDuringFoldAnimation() throws { try run(phase: "fold") }
    func testSingleRowStatusDuringScrolling() throws {
        try run(phase: "drag", modes: ["none", "statusSingle", "status"])
        try run(phase: "momentum", modes: ["none", "statusSingle", "status"])
    }
    func testSingleRowStatusDuringFoldAnimation() throws {
        try run(phase: "fold", modes: ["foldControl", "foldSingle", "foldOverlap"])
    }

    func testTypographyMatchesLegacy() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-homeScrollDiagnostic", "-diagnosticMode", "none", "-diagnosticPhase", "typography"]
        app.launch()
        XCTAssertTrue(app.scrollViews["home-diagnostic-list"].waitForExistence(timeout: 20))
        let value = try XCTUnwrap(app.otherElements["home-diagnostic-probe"].value as? String)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
        XCTAssertEqual(result["labelSize"] as? Double, 17)
        XCTAssertEqual(result["sectionLabelSize"] as? Double, 11)
        print("HOME_TYPOGRAPHY category=\(result["contentSizeCategory"] ?? "unknown") title=17 section=11")
        let current = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        current.name = "home-typography-current-legacy-sizes"; current.lifetime = .keepAlways; add(current)
        app.terminate()
        app.launchArguments = ["-screen", "home", "-renderer", "UITableView", "-grouping", "project"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1)
        let legacy = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        legacy.name = "home-typography-legacy-reference"; legacy.lifetime = .keepAlways; add(legacy)
        app.terminate()
    }

    private func run(phase: String, modes requestedModes: [String]? = nil) throws {
        let modes = requestedModes ?? (phase == "fold" ? ["foldControl", "foldOverlap"] : ["none", "status", "resizeAbove", "insertAbove", "deleteAbove", "deleteAnchor", "reorderAnchor"])
        for mode in modes {
            let app = XCUIApplication()
            app.launchArguments = ["-homeScrollDiagnostic", "-diagnosticMode", mode, "-diagnosticPhase", phase]
            app.launch()
            let list = app.scrollViews["home-diagnostic-list"]
            XCTAssertTrue(list.waitForExistence(timeout: 20))
            let window = app.windows.firstMatch
            let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.76))
            let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.26))
            if phase == "fold" {
                app.descendants(matching: .any)["row:section:Tasks 3"].firstMatch.tap()
            } else {
                from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: phase == "drag" ? 180 : 1400), thenHoldForDuration: phase == "drag" ? 0.5 : 0)
            }
            Thread.sleep(forTimeInterval: 1.5)
            let value = try XCTUnwrap(app.otherElements["home-diagnostic-probe"].value as? String)
            let data = Data(value.utf8)
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let events = try XCTUnwrap(result["events"] as? [[String: Any]])
            XCTAssertEqual(events.count, 1, "\(mode): the intended gesture phase was not observed")
            let trace = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            trace.name = "home-diagnostic-\(phase)-\(mode)"; trace.lifetime = .keepAlways; add(trace)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "home-diagnostic-\(phase)-\(mode)"; shot.lifetime = .keepAlways; add(shot)
            print("HOME_DIAGNOSTIC \(phase) \(mode) \(events)")
            app.terminate()
        }
    }
}