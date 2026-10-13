import Foundation
import XCTest
@testable import HappyCore

/// Opt-in: compares `DiffSyntax.highlightLines` with prismjs over real
/// files, run for run. Make the reference with
/// `scripts/generate-prism-grammars.cjs <node_modules> --reference <out.json> <language>:<file>...`
/// and run with `PRISM_CORPUS=<out.json>`.
final class PrismCorpusTests: XCTestCase {
    func testCorpus() throws {
        guard let path = ProcessInfo.processInfo.environment["PRISM_CORPUS"] else { throw XCTSkip("PRISM_CORPUS is not set") }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let entries = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        var failures = 0
        for entry in entries {
            let language = try XCTUnwrap(entry["lang"] as? String)
            let text = try XCTUnwrap(entry["text"] as? String)
            let file = entry["file"] as? String ?? "?"
            let runs = try XCTUnwrap(entry["runs"] as? [[[String: Any]]])
            let expected = try runs.map { line in
                try line.map { run in
                    DiffSyntaxRun(try XCTUnwrap(DiffSpanKind(rawValue: run["k"] as? String ?? "")), try XCTUnwrap(run["n"] as? Int))
                }
            }
            let actual = DiffSyntax.highlightLines(text, language: language)
            guard actual != expected else { continue }
            failures += 1
            let lines = text.components(separatedBy: "\n")
            if let index = (0..<max(actual.count, expected.count)).first(where: { index in
                (index < actual.count ? actual[index] : []) != (index < expected.count ? expected[index] : [])
            }) {
                let line = index < lines.count ? String(lines[index].prefix(160)) : "?"
                XCTFail("\(language) \(file) line \(index + 1): \(line)")
            }
        }
        XCTAssertEqual(failures, 0, "\(failures) of \(entries.count) files differ")
    }
}
