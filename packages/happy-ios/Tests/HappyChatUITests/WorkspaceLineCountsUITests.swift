import XCTest

/// Real native Home over the existing offline fixture transport, including
/// the Git subscription response. Never reads or changes a signed-in account.
@MainActor
final class WorkspaceLineCountsUITests: XCTestCase {
    func testTaskAndSubtaskCountsLightAndDark() {
        continueAfterFailure = false
        _ = skipsQuiescence
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-screen", "groupedHome", "-lineCounts", "-\(appearance)"]
            app.launch()
            let task = app.descendants(matching: .any)["row:space:Fix login crash"]
            XCTAssertTrue(task.waitForExistence(timeout: 30))
            let counts = NSPredicate(format: "value CONTAINS %@", "+309 −324")
            expectation(for: counts, evaluatedWith: task)
            waitForExpectations(timeout: 15)
            let child = app.descendants(matching: .any)["row:session:Write the regression test"]
            if !child.isHittable { app.swipeUp() }
            XCTAssertTrue(child.waitForExistence(timeout: 5))
            XCTAssertTrue((child.value as? String)?.contains("≈ +12345 −1234") == true)
            let clean = app.descendants(matching: .any)["row:space:Quarterly report"]
            XCTAssertFalse((clean.value as? String)?.contains("+0") == true)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "iphone12-line-counts-\(appearance)-fixture"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }
}