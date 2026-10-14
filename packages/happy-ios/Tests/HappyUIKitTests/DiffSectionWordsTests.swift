#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// A changes-list section is planned off the main thread and says the words
/// its input carries, taken on the main thread; the screens' strings, which
/// live there, are never read (Debug builds stop if they are).
@MainActor
final class DiffSectionWordsTests: XCTestCase {
    private let words = DiffSectionWords(noChanges: "none", binaryFile: "binary", imageBefore: "was", imageAfter: "is")

    private func input(_ item: DiffFileItem, sizeHint: String? = nil) -> DiffSectionInput {
        DiffSectionInput(item: item, collapsed: sizeHint != nil, sizeHint: sizeHint, canExpandContext: false, expandedFiles: [], words: words)
    }

    func testAPlanMadeOffTheMainThreadSaysItsInputsWords() async {
        let render = RenderServices.isolated()
        let inputs = [
            input(DiffFileItem(path: "a.swift", kind: .modified, additions: 0, deletions: 0, source: .contents(path: "a.swift", oldText: "same", newText: "same"))),
            input(DiffFileItem(path: "a.png", kind: .modified, additions: 0, deletions: 0, image: .init(before: nil, after: nil))),
            input(DiffFileItem(path: "b.png", kind: .modified, additions: 0, deletions: 0, image: .init(before: Data(), after: Data()))),
            input(DiffFileItem(path: "c.swift", kind: .modified, additions: 2500, deletions: 3), sizeHint: "2503 lines"),
        ]
        let plans = await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            return inputs.map { DiffSectionPlan($0, width: 393, scale: 3, render: render) }
        }.value
        guard case .message(let none) = plans[0].body else { return XCTFail("no changes") }
        XCTAssertEqual(none.string, "none")
        guard case .message(let binary) = plans[1].body else { return XCTFail("binary") }
        XCTAssertEqual(binary.string, "binary")
        guard case .image(let sides, _) = plans[2].body else { return XCTFail("before and after") }
        XCTAssertEqual(sides.map(\.0), ["was", "is"])
        guard case .hint(let hint) = plans[3].body else { return XCTFail("size hint") }
        XCTAssertEqual(hint.string, "2503 lines")
    }

    /// Other words are another input, so the list plans the section again.
    func testOtherWordsAreAnotherInput() {
        let item = DiffFileItem(path: "a.swift", kind: .modified, additions: 1, deletions: 1)
        var other = input(item)
        other.words.noChanges = "keine"
        XCTAssertNotEqual(input(item), other)
        XCTAssertEqual(DiffSectionWords().noChanges, Strings.DiffDetail.noChanges)
    }
}
#endif
