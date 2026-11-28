import HappyCore
import XCTest

/// The sign-in code in whatever a person copied out of their mail app.
final class EmailCodeTests: XCTestCase {
    func testTheCodeAloneIsTheCode() {
        XCTAssertEqual(EmailCode.find(in: "123456"), "123456")
        XCTAssertEqual(EmailCode.find(in: " 123456\n"), "123456")
        XCTAssertEqual(EmailCode.find(in: "000000"), "000000")
    }

    func testTheFirstRunOfExactlySixDigitsIsTaken() {
        XCTAssertEqual(EmailCode.find(in: "Your Happy sign-in code is 428913. It expires in 10 minutes."), "428913")
        XCTAssertEqual(EmailCode.find(in: "428913 is your code"), "428913")
        XCTAssertEqual(EmailCode.find(in: "Code: 428913\nDidn’t ask for it? Ignore this email."), "428913")
        XCTAssertEqual(EmailCode.find(in: "111111 or 222222"), "111111", "the first")
        // A longer or shorter number beside it isn't the code.
        XCTAssertEqual(EmailCode.find(in: "Order 20261128, code 428913"), "428913")
        XCTAssertEqual(EmailCode.find(in: "© 2026 Happy. Code 428913, ref 12345678"), "428913")
        XCTAssertEqual(EmailCode.find(in: "10 minutes left for 428913"), "428913")
        XCTAssertEqual(EmailCode.find(in: "https://auth.happy.engineering/?code=428913&x=1"), "428913")
    }

    func testSixDigitsInAllAreTheCodeHoweverTheyAreSpaced() {
        XCTAssertEqual(EmailCode.find(in: "123 456"), "123456")
        XCTAssertEqual(EmailCode.find(in: "123-456"), "123456")
        XCTAssertEqual(EmailCode.find(in: "1 2 3 4 5 6"), "123456")
        XCTAssertEqual(EmailCode.find(in: "Code: 12 34 56."), "123456")
    }

    func testTextWithoutACodeHasNone() {
        for text in ["", "hello", "12345", "1234567", "12345678901", "123 4567", "call 555 0100 2368", "2026-11-28 03:22", "１２３４５６", "١٢٣٤٥٦", "12345\u{301}6"] {
            XCTAssertNil(EmailCode.find(in: text), text)
        }
    }

    func testTheLengthIsSix() {
        XCTAssertEqual(EmailCode.length, 6)
    }
}
