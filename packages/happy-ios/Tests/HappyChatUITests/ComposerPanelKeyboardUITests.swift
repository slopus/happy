import XCTest

/// Real software keyboard and editor identity across composer overlays.
/// The probe's continuous counters catch transient blur/re-focus that a
/// before/after first-responder check alone would miss.
@MainActor
final class ComposerPanelKeyboardUITests: XCTestCase {
    private let draft = "Panel validation keeps this draft and selection."
    private var app: XCUIApplication!

    private func read() throws -> [String: Any] {
        let element = app.otherElements["composer-keyboard-probe"]
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        let value = try XCTUnwrap(element.value as? String)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }

    private func waitForState(_ predicate: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(12)
        var latest: [String: Any] = [:]
        repeat {
            latest = try read()
            if predicate(latest) { return latest }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTFail("Composer state did not settle: \(latest.filter { $0.key != "frames" })")
        return latest
    }

    private func rectangle(_ value: Any?) throws -> CGRect {
        let numbers = try XCTUnwrap(value as? [Double])
        XCTAssertEqual(numbers.count, 4)
        return CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
    }

    private func start(arguments: [String], orientation: UIDeviceOrientation = .portrait) throws -> [String: Any] {
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = orientation
        app = XCUIApplication()
        app.launchArguments = arguments + ["-composerKeyboardProbe", "-composerProbeDraft", draft, "-composerProbeRange", "6,10"]
        app.launch()
        let ready = try waitForState { $0["ready"] as? Bool == true }
        let editor = try rectangle(ready["editorFrame"])
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.midX, dy: editor.midY)).tap()
        app.typeText(draft)
        let baseline = try waitForState { $0["firstResponder"] as? Bool == true && $0["keyboardVisible"] as? Bool == true && $0["selectionSeeded"] as? Bool == true }
        XCTAssertEqual(baseline["draft"] as? String, draft)
        XCTAssertEqual(baseline["selection"] as? [Int], [6, 10])
        XCTAssertTrue(app.keyboards.firstMatch.exists, "a first responder with only a hardware keyboard is insufficient")
        return baseline
    }

    private func preserve(_ baseline: [String: Any], phase: String) throws -> [String: Any] {
        let current = try read()
        XCTAssertEqual(current["editorID"] as? String, baseline["editorID"] as? String, phase)
        XCTAssertEqual(current["responderID"] as? String, baseline["responderID"] as? String, phase)
        XCTAssertEqual(current["firstResponder"] as? Bool, true, phase)
        XCTAssertEqual(current["keyboardVisible"] as? Bool, true, phase)
        XCTAssertEqual(current["draft"] as? String, baseline["draft"] as? String, phase)
        XCTAssertEqual(current["selection"] as? [Int], baseline["selection"] as? [Int], phase)
        for counter in ["keyboardHides", "editingEnds", "lostResponderFrames", "missingKeyboardFrames"] {
            XCTAssertEqual(current[counter] as? Int, baseline[counter] as? Int, "\(phase): \(counter)")
        }
        for key in ["keyboardFrame", "cardFrame"] {
            let old = try rectangle(baseline[key])
            let new = try rectangle(current[key])
            XCTAssertEqual(new.minY, old.minY, accuracy: 1, "\(phase): \(key)")
            XCTAssertEqual(new.height, old.height, accuracy: 1, "\(phase): \(key)")
        }
        let attachment = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: current), encoding: .utf8)!)
        attachment.name = phase
        attachment.lifetime = .keepAlways
        add(attachment)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = phase
        screenshot.lifetime = .keepAlways
        add(screenshot)
        return current
    }

    private func assertPanel(_ id: String, in state: [String: Any]) throws {
        let panels = try XCTUnwrap(state["panels"] as? [[String: Any]])
        let panel = try XCTUnwrap(panels.first { $0["id"] as? String == id }, "\(id) is not visible")
        let frame = try rectangle(panel["frame"])
        let keyboard = try rectangle(state["keyboardFrame"])
        let window = try rectangle(state["window"])
        let safe = try XCTUnwrap(state["safeArea"] as? [Double])
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(frame.height, 0)
        XCTAssertGreaterThanOrEqual(frame.minX, window.minX + safe[1] - 1)
        XCTAssertLessThanOrEqual(frame.maxX, window.maxX - safe[3] + 1)
        XCTAssertGreaterThanOrEqual(frame.minY, window.minY + safe[0] - 1)
        XCTAssertLessThanOrEqual(frame.maxY, keyboard.minY + 1, "the panel overlaps the software keyboard")
    }

    override func tearDown() {
        app?.terminate()
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    func testProbeCapturesSoftwareKeyboardDraftAndNonemptySelection() throws {
        let baseline = try start(arguments: ["-fixture", "long"])
        _ = try preserve(baseline, phase: "focused editor baseline")
    }
}