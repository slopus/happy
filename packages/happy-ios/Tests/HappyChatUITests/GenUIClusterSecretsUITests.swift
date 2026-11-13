import XCTest

/// A Gen UI's Happy Cloud secret buttons in a conversation on a cloud
/// server (`-screen genuiChat -genuiCloud`, the harness's
/// `cluster-secrets` document): each opens the cluster's form of its type,
/// prefilled; saved, the element is marked and opens on what it made; one
/// naming a stored secret changes it, keeping a value left empty.
@MainActor
final class GenUIClusterSecretsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        app = XCUIApplication()
        app.launchArguments = ["-screen", "genuiChat", "-genuiCloud", "-genuiCount", "1", "-genuiExamples", "cluster-secrets"]
        app.launch()
    }

    /// With `GENUI_SHOTS` (`TEST_RUNNER_GENUI_SHOTS`), the screen is kept there as `name`.png.
    private func shoot(_ name: String) {
        guard let folder = ProcessInfo.processInfo.environment["GENUI_SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }

    private func button(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func reach(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 20), "\(element) never drawn")
        for _ in 0..<6 where !element.isHittable { app.swipeDown() }
        XCTAssertTrue(element.isHittable)
        sleep(2)
    }

    private func field(_ id: String) -> XCUIElement { app.textFields["genui-secret-\(id)"] }
    private func secure(_ id: String) -> XCUIElement { app.secureTextFields["genui-secret-\(id)"] }

    func testAnEndpointSecretIsAddedThenOpensOnWhatItMade() {
        let add = button("Add Stripe key")
        reach(add)
        shoot("cluster-buttons")
        add.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10), "no cluster secret form")
        XCTAssertEqual(field("name").value as? String, "Stripe API")
        XCTAssertEqual(field("target-0-host").value as? String, "api.stripe.com")
        XCTAssertEqual(field("header-1-name").value as? String, "Authorization")
        let value = secure("header-1-value")
        XCTAssertTrue(value.waitForExistence(timeout: 5))
        XCTAssertEqual(value.placeholderValue, "Value of Authorization")
        shoot("cluster-endpoint")
        value.tap()
        value.typeText("sk_test_123")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.navigationBars["Secret Added"].waitForExistence(timeout: 10), "not saved")
        XCTAssertTrue(app.staticTexts["Added Stripe API"].exists)
        shoot("cluster-added")
        app.buttons["Done"].tap()
        XCTAssertTrue(add.waitForExistence(timeout: 5))

        // Opened again, it shows what it made, to save again.
        add.tap()
        XCTAssertTrue(app.navigationBars["Change Secret"].waitForExistence(timeout: 10), "not opened on the saved secret")
        XCTAssertEqual(field("name").value as? String, "Stripe API")
        app.buttons["genui-secret-cancel"].tap()
    }

    func testAStoredSecretIsChangedKeepingAnEmptyValue() {
        let rotate = button("Rotate Stripe key")
        reach(rotate)
        rotate.tap()
        XCTAssertTrue(app.navigationBars["Change Secret"].waitForExistence(timeout: 10), "not opened on the stored secret")
        XCTAssertEqual(field("description").value as? String, "Stripe live key")
        let value = app.secureTextFields.matching(NSPredicate(format: "identifier ENDSWITH %@", "-value")).firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 5))
        XCTAssertEqual(value.placeholderValue, "Keep the stored value")
        shoot("cluster-change")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.navigationBars["Secret Updated"].waitForExistence(timeout: 10), "not changed")
        XCTAssertTrue(app.staticTexts["Updated Stripe API"].exists)
        app.buttons["Done"].tap()
    }

    func testAGitTokenIsAdded() {
        let add = button("Add GitHub token")
        reach(add)
        add.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10), "no cluster secret form")
        XCTAssertEqual(field("server").value as? String, "github.com")
        XCTAssertEqual(field("repos").value as? String, "slopus/happy")
        shoot("cluster-git")
        let token = secure("token")
        for _ in 0..<4 where !token.isHittable { app.swipeUp() }
        sleep(1)
        token.tap()
        token.typeText("ghp_123")
        app.buttons["genui-secret-save"].tap()
        XCTAssertTrue(app.staticTexts["Added GitHub"].waitForExistence(timeout: 10), "not saved")
        app.buttons["Done"].tap()
    }

    func testTheOtherTypesOpenPrefilled() {
        let environment = button("Add OpenAI keys")
        reach(environment)
        environment.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10))
        XCTAssertEqual(field("variable-0-name").value as? String, "OPENAI_API_KEY")
        XCTAssertEqual(field("variable-1-name").value as? String, "OPENAI_ORG")
        shoot("cluster-environment")
        app.buttons["genui-secret-cancel"].tap()

        let ssh = button("Add deploy key")
        reach(ssh)
        ssh.tap()
        XCTAssertTrue(app.navigationBars["New Secret"].waitForExistence(timeout: 10))
        XCTAssertEqual(field("hosts").value as? String, "deploy.example.com")
        XCTAssertEqual(field("ssh-ports").value as? String, "22")
        shoot("cluster-ssh")
        app.buttons["genui-secret-cancel"].tap()
    }
}
