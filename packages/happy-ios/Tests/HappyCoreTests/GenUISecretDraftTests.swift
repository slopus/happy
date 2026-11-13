import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// The Happy Agent secret form as the person edits it: started from the
/// action's prefill, all of it changeable, making a whole bundle or a patch
/// of a stored secret, and saying what stops a save.
final class GenUISecretDraftTests: XCTestCase {
    private let prefill = GenUISecretPrefill(id: "stripe", description: "Stripe test keys", variables: [
        .init(name: "STRIPE_SECRET_KEY", description: "starts with sk_test_"), .init(name: "STRIPE_WEBHOOK_SECRET"),
    ])

    func testANewSecretIsTheWholeBundleOnceEveryValueIsTyped() throws {
        var draft = GenUISecretDraft(prefill)
        XCTAssertEqual(draft.name, "stripe")
        XCTAssertEqual(draft.rows.map(\.name), ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
        XCTAssertEqual(draft.rows.first?.hint, "starts with sk_test_")
        XCTAssertEqual(draft.problems, [.value])
        draft.type(draft.rows[0].id, "sk_test_1")
        draft.type(draft.rows[1].id, "whsec_1")
        XCTAssertEqual(draft.problems, [])
        let (secret, ifMatch) = draft.form()
        XCTAssertNil(ifMatch)
        XCTAssertEqual(secret, .object([
            "id": .string("stripe"), "description": .string("Stripe test keys"),
            "environment": .object(["STRIPE_SECRET_KEY": .string("sk_test_1"), "STRIPE_WEBHOOK_SECRET": .string("whsec_1")]),
        ]))
        draft.forget()
        XCTAssertTrue(draft.rows.allSatisfy { $0.value.isEmpty })
    }

    func testEveryFieldMayChange() {
        var draft = GenUISecretDraft(prefill)
        draft.name = "billing"
        draft.describe("Billing keys")
        draft.rename(draft.rows[0].id, to: "BILLING_KEY")
        draft.remove(draft.rows[1].id)
        draft.add()
        draft.rename(draft.rows[1].id, to: "BILLING_ACCOUNT")
        for row in draft.rows { draft.type(row.id, "v") }
        XCTAssertEqual(draft.problems, [])
        XCTAssertEqual(draft.form().secret["environment"], .object(["BILLING_KEY": .string("v"), "BILLING_ACCOUNT": .string("v")]))
        XCTAssertEqual(draft.form().secret["description"], .string("Billing keys"))
    }

    func testChangingAStoredSecretSendsAPatchAndItsVersion() {
        var draft = GenUISecretDraft(prefill)
        draft.adopt(StoredSecret(id: "stripe", description: "Stored", environmentVariables: ["OLD_KEY", "stripe_secret_key"], version: "v7"))
        XCTAssertTrue(draft.changing)
        // A stored name matched ignoring case takes the stored spelling; one the action didn't name joins.
        XCTAssertEqual(draft.rows.map(\.name), ["stripe_secret_key", "STRIPE_WEBHOOK_SECRET", "OLD_KEY"])
        XCTAssertEqual(draft.description, "Stored")
        // Left empty, a stored one keeps its value; a new one still needs one.
        XCTAssertEqual(draft.problems, [.value])
        draft.type(draft.rows[1].id, "whsec_2")
        XCTAssertEqual(draft.problems, [])
        draft.remove(draft.rows[2].id)
        let (secret, ifMatch) = draft.form()
        XCTAssertEqual(ifMatch, "v7")
        XCTAssertEqual(secret["environment"], .object(["OLD_KEY": .null, "STRIPE_WEBHOOK_SECRET": .string("whsec_2")]))

        // Renamed, a stored one is removed and the new name needs a value.
        draft.rename(draft.rows[0].id, to: "STRIPE_KEY")
        XCTAssertEqual(draft.problems, [.value])
        draft.type(draft.rows[0].id, "sk_2")
        XCTAssertEqual(draft.form().secret["environment"], .object([
            "OLD_KEY": .null, "stripe_secret_key": .null, "STRIPE_KEY": .string("sk_2"), "STRIPE_WEBHOOK_SECRET": .string("whsec_2"),
        ]))
    }

    func testANameThatNoLongerNamesAStoredSecretMakesANewOne() {
        var draft = GenUISecretDraft(prefill)
        draft.adopt(StoredSecret(id: "stripe", description: "Stored", environmentVariables: ["OLD_KEY"], version: "v1"))
        draft.name = "stripe2"
        draft.adopt(nil)
        XCTAssertFalse(draft.changing)
        XCTAssertEqual(draft.rows.map(\.name), ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
        XCTAssertEqual(draft.description, "Stripe test keys")
        XCTAssertNil(draft.form().ifMatch)
    }

    func testWhatStopsASave() {
        var draft = GenUISecretDraft(prefill)
        for row in draft.rows { draft.type(row.id, "v") }
        draft.name = "Stripe"
        XCTAssertEqual(draft.problems, [.name])
        draft.name = "stripe"
        draft.describe("  ")
        XCTAssertEqual(draft.problems, [.description])
        draft.describe("ok")
        draft.rename(draft.rows[1].id, to: "stripe_secret_key")
        XCTAssertEqual(draft.problems, [.variableTwice])
        draft.rename(draft.rows[1].id, to: "1BAD")
        XCTAssertEqual(draft.problems, [.variableName])
        draft.remove(draft.rows[1].id)
        draft.remove(draft.rows[0].id)
        XCTAssertEqual(draft.problems, [.noVariables])
        draft.add()
        draft.rename(draft.rows[0].id, to: "KEY")
        draft.type(draft.rows[0].id, "a\0b")
        XCTAssertEqual(draft.problems, [.value])
        draft.type(draft.rows[0].id, "ab")
        draft.adopt(StoredSecret(id: "stripe", description: "x", environmentVariables: ["KEY"], managed: true, version: "v"))
        XCTAssertEqual(draft.problems, [.managed])
    }

    func testASavedSecretOpensTheFormOnItsName() {
        XCTAssertEqual(GenUISecretDraft(prefill, name: "stripe-test").name, "stripe-test")
        XCTAssertEqual(GenUISecretDraft(GenUISecretPrefill(variables: [.init(name: "K")])).name, "")
    }
}
