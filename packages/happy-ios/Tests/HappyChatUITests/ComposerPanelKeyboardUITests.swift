import XCTest

/// Real software keyboard and editor identity across composer overlays.
/// The probe's continuous counters catch transient blur/re-focus that a
/// before/after first-responder check alone would miss.
@MainActor
final class ComposerPanelKeyboardUITests: XCTestCase {
    private let draft = "Panel validation keeps this draft and selection \(UUID().uuidString.prefix(8))."
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

    private func start(arguments: [String], orientation: UIDeviceOrientation = .portrait, environment: [String: String] = [:], row: String? = nil) throws -> [String: Any] {
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = orientation
        app = XCUIApplication()
        app.launchArguments = arguments + ["-composerKeyboardProbe", "-composerProbeDraft", draft, "-composerProbeRange", "6,10"]
        app.launchEnvironment = environment
        app.launch()
        if let row {
            let task = app.descendants(matching: .any).matching(identifier: "row:space:\(row)").firstMatch
            XCTAssertTrue(task.waitForExistence(timeout: 30), "the isolated synthetic task is missing")
            task.tap()
        }
        let ready = try waitForState { $0["ready"] as? Bool == true }
        let editor = try rectangle(ready["editorFrame"])
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: editor.midX, dy: editor.midY)).tap()
        app.typeKey("a", modifierFlags: .command)
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
        let frame = try rectangle(panel["visibleFrame"])
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

    private func startAgent(orientation: UIDeviceOrientation = .portrait) throws -> [String: Any] {
        let environment = ProcessInfo.processInfo.environment
        guard environment["COMPOSER_PANEL_QA"] == "1", let socket = environment["AGENT_SOCKET"],
              let token = environment["AGENT_TOKEN"], let row = environment["COMPOSER_PANEL_ROW"] else {
            throw XCTSkip("Opt-in synthetic fixture: set TEST_RUNNER_COMPOSER_PANEL_QA, AGENT_SOCKET, AGENT_TOKEN and COMPOSER_PANEL_ROW")
        }
        return try start(arguments: ["-screen", "agent", "-agentSocket", socket], orientation: orientation,
                         environment: ["HAPPY_AGENT_FIXTURE_TOKEN": token], row: row)
    }

    private func tapChip(_ kind: String, state: [String: Any]) throws {
        let chips = try XCTUnwrap(state["chips"] as? [[String: Any]])
        let chip = try XCTUnwrap(chips.first { $0["kind"] as? String == kind })
        let frame = try rectangle(chip["frame"])
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
    }

    private func hasPanel(_ id: String, _ state: [String: Any]) -> Bool {
        (state["panels"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id }
    }

    private func outsidePanel(_ id: String, state: [String: Any]) throws {
        let panel = try XCTUnwrap((state["panels"] as? [[String: Any]])?.first { $0["id"] as? String == id })
        let frame = try rectangle(panel["visibleFrame"])
        let safe = try XCTUnwrap(state["safeArea"] as? [Double])
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: safe[1] + 2, dy: frame.midY)).tap()
    }

    func testMainModelPanelPreservesKeyboardDraftAndSelection() throws {
        let baseline = try startAgent()
        try tapChip("model", state: baseline)
        _ = try waitForState { self.hasPanel("picker-models", $0) }
        let opened = try preserve(baseline, phase: "model panel open")
        try assertPanel("picker-models", in: opened)
        let choices = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "picker-row:model\t"))
        let choice = try XCTUnwrap(choices.allElementsBoundByIndex.first { $0.isEnabled && $0.isHittable }, "no selectable synthetic model")
        choice.tap()
        _ = try waitForState { !self.hasPanel("picker-models", $0) }
        let selected = try preserve(baseline, phase: "model selected")
        try tapChip("model", state: selected)
        let reopened = try waitForState { self.hasPanel("picker-models", $0) }
        try outsidePanel("picker-models", state: reopened)
        _ = try waitForState { !self.hasPanel("picker-models", $0) }
        _ = try preserve(baseline, phase: "model outside dismissal")
    }

    func testMainAttachmentPanelPreservesKeyboardDraftAndSelection() throws {
        let baseline = try startAgent()
        let add = app.buttons["Add a picture"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        _ = try waitForState { self.hasPanel("attach-sheet", $0) }
        let opened = try preserve(baseline, phase: "attachment panel open")
        try assertPanel("attach-sheet", in: opened)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "attach-permission").firstMatch.exists)
        app.buttons["attach-close"].tap()
        _ = try waitForState { !self.hasPanel("attach-sheet", $0) }
        _ = try preserve(baseline, phase: "attachment close")
        add.tap()
        let reopened = try waitForState { self.hasPanel("attach-sheet", $0) }
        try outsidePanel("attach-sheet", state: reopened)
        _ = try waitForState { !self.hasPanel("attach-sheet", $0) }
        _ = try preserve(baseline, phase: "attachment outside dismissal")
    }

    func testTheDetailsPermissionModeKeepsTheDraft() throws {
        let baseline = try startAgent()
        let compose = app.buttons["compose"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-more"].exists, "Back, the name, and Compose alone")
        let composeFrame = compose.frame
        let titleFrame = try rectangle(baseline["headerTitleFrame"])
        XCTAssertLessThanOrEqual(titleFrame.maxX, composeFrame.minX + 1, "title must fit before Compose")
        let headerFrames = XCTAttachment(string: "title=\(titleFrame) compose=\(composeFrame)")
        headerFrames.name = "actual portrait header frames"
        headerFrames.lifetime = .keepAlways
        add(headerFrames)
        func keep(_ phase: String) {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = phase
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }

        // The permission mode is on the detail the name opens.
        app.descendants(matching: .any)["chat-title"].tap()
        let permission = app.buttons["profile-permission-mode"]
        XCTAssertTrue(permission.waitForExistence(timeout: 5), app.debugDescription)
        keep("detail permission row")
        permission.tap()
        let key = "permission\tworkspace_write"
        let choice = app.buttons[key]
        XCTAssertTrue(choice.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(choice.isEnabled)
        keep("detail permission choices")
        choice.tap()
        XCTAssertFalse(choice.exists)
        permission.tap()
        XCTAssertTrue(app.buttons[key].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons[key].isSelected, "the chosen permission must be checked on reopening")
        keep("detail permission checked")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        app.navigationBars.firstMatch.buttons.element(boundBy: 0).tap()
        let back = try waitForState { $0["ready"] as? Bool == true }
        XCTAssertEqual(back["draft"] as? String, baseline["draft"] as? String, "the detail keeps the draft")
        app.buttons["Back"].tap()
        let row = try XCTUnwrap(ProcessInfo.processInfo.environment["COMPOSER_PANEL_ROW"])
        let task = app.descendants(matching: .any).matching(identifier: "row:space:\(row)").firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 10))
        task.tap()
        let restored = try waitForState { $0["ready"] as? Bool == true && $0["draft"] as? String == self.draft }
        XCTAssertEqual(restored["draft"] as? String, draft, "normal Back must preserve the synthetic draft")
    }

    func testCompactLandscapeModelsEffortAndAttachmentsKeepKeyboard() throws {
        let baseline = try startAgent(orientation: .landscapeLeft)
        XCTAssertEqual(baseline["compact"] as? Bool, true)
        let options = app.buttons["composer-options"]
        XCTAssertTrue(options.exists)
        options.tap()
        _ = try waitForState { self.hasPanel("composer-options-panel", $0) }
        let opened = try preserve(baseline, phase: "landscape compact options")
        try assertPanel("composer-options-panel", in: opened)
        let chips = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "picker-row:chip:"))
        XCTAssertEqual(chips.count, 2, "compact options contain model and effort only")
        XCTAssertFalse(chips.allElementsBoundByIndex.contains { $0.label.localizedCaseInsensitiveContains("permission") })
        app.buttons["picker-row:chip:0"].tap()
        _ = try waitForState { self.hasPanel("picker-models", $0) }
        let models = try preserve(baseline, phase: "landscape model panel")
        try assertPanel("picker-models", in: models)
        try outsidePanel("picker-models", state: models)
        _ = try waitForState { !self.hasPanel("picker-models", $0) }
        options.tap()
        _ = try waitForState { self.hasPanel("composer-options-panel", $0) }
        app.buttons["picker-row:chip:1"].tap()
        _ = try waitForState { self.hasPanel("picker-efforts", $0) }
        let efforts = try preserve(baseline, phase: "landscape effort panel")
        try assertPanel("picker-efforts", in: efforts)
        let choices = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "picker-row:effort\t"))
        try XCTUnwrap(choices.allElementsBoundByIndex.first { $0.isEnabled && $0.isHittable }).tap()
        _ = try waitForState { !self.hasPanel("picker-efforts", $0) }
        _ = try preserve(baseline, phase: "landscape effort selected")
        app.buttons["Add a picture"].tap()
        _ = try waitForState { self.hasPanel("attach-sheet", $0) }
        let attachment = try preserve(baseline, phase: "landscape attachment panel")
        try assertPanel("attach-sheet", in: attachment)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "attach-permission").firstMatch.exists)
        let panel = try XCTUnwrap((attachment["panels"] as? [[String: Any]])?.first { $0["id"] as? String == "attach-sheet" })
        let scrolls = try XCTUnwrap(panel["scrolls"] as? [[String: Any]])
        XCTAssertTrue(try scrolls.contains { scroll in
            let frame = try rectangle(scroll["frame"])
            let content = try XCTUnwrap(scroll["contentSize"] as? [Double])
            return content[1] > frame.height + 1 && scroll["scrollEnabled"] as? Bool == true
        }, "compact attachment content must scroll vertically")
        app.buttons["attach-close"].tap()
        _ = try waitForState { !self.hasPanel("attach-sheet", $0) }
        _ = try preserve(baseline, phase: "landscape attachment dismissed")
    }
}