import Foundation
@testable import HappyCore
import XCTest

final class ArtifactMarkdownTests: XCTestCase {
    private func file(_ path: String, _ fragment: String? = nil) -> ArtifactReference { .file(path, fragment: fragment) }

    func testRelativePathsResolveAgainstTheDocumentsFolder() {
        XCTAssertEqual(ArtifactMarkdown.resolve("images/chart.png", from: "index.md"), file("images/chart.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("chart.png", from: "docs/guide.md"), file("docs/chart.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("a/b/c.png", from: "docs/deep/guide.md"), file("docs/deep/a/b/c.png"))
    }

    func testDotSegments() {
        XCTAssertEqual(ArtifactMarkdown.resolve("./images/a.png", from: "index.md"), file("images/a.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("../shared/a.png", from: "docs/guide.md"), file("shared/a.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("./x/../y/./a.png", from: "docs/guide.md"), file("docs/y/a.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("../../a.png", from: "docs/deep/guide.md"), file("a.png"))
    }

    func testRootRelativeStaysInTheVersion() {
        XCTAssertEqual(ArtifactMarkdown.resolve("/images/a.png", from: "docs/guide.md"), file("images/a.png"))
    }

    func testPathsThatEscapeAreRefused() {
        XCTAssertEqual(ArtifactMarkdown.resolve("../a.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("../../a.png", from: "docs/guide.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("a/../../b.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("/../a.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("%2E%2E/a.png", from: "index.md"), .refused)
        // An encoded separator or backslash names nothing the daemon holds.
        XCTAssertEqual(ArtifactMarkdown.resolve("..%2Fa.png", from: "docs/guide.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("images%2Fa.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("images%5Ca.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("a%00.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("bad%zz.png", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("images/", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve(".", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("javascript:alert(1)", from: "index.md"), .refused)
        XCTAssertEqual(ArtifactMarkdown.resolve("file:///etc/passwd", from: "index.md"), .refused)
    }

    func testPercentEncoding() {
        XCTAssertEqual(ArtifactMarkdown.resolve("images/my%20chart.png", from: "index.md"), file("images/my chart.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("caf%C3%A9.png", from: "index.md"), file("café.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("<images/my chart.png>", from: "index.md"), file("images/my chart.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("chart%281%29.png", from: "index.md"), file("chart(1).png"))
    }

    func testAnchorsAndQueries() {
        XCTAssertEqual(ArtifactMarkdown.resolve("guide.md#setup", from: "index.md"), file("guide.md", "setup"))
        XCTAssertEqual(ArtifactMarkdown.resolve("a.png?v=2", from: "index.md"), file("a.png"))
        XCTAssertEqual(ArtifactMarkdown.resolve("a.png?v=2#x", from: "index.md"), file("a.png", "x"))
        XCTAssertEqual(ArtifactMarkdown.resolve("#results", from: "index.md"), .fragment("results"))
        XCTAssertEqual(ArtifactMarkdown.resolve("#caf%C3%A9", from: "index.md"), .fragment("café"))
    }

    func testTitlesAreNotPartOfTheAddress() {
        XCTAssertEqual(ArtifactMarkdown.resolve(#"a.png "A chart""#, from: "index.md"), file("a.png"))
    }

    func testOtherSchemes() {
        XCTAssertEqual(ArtifactMarkdown.resolve("https://cdn.example.com/a.png", from: "index.md"), .web(URL(string: "https://cdn.example.com/a.png")!))
        XCTAssertEqual(ArtifactMarkdown.resolve("HTTP://cdn.example.com/a.png", from: "index.md"), .web(URL(string: "HTTP://cdn.example.com/a.png")!))
        XCTAssertEqual(ArtifactMarkdown.resolve("//cdn.example.com/a.png", from: "index.md"), .web(URL(string: "https://cdn.example.com/a.png")!))
        XCTAssertEqual(ArtifactMarkdown.resolve("data:image/png;base64,AAAA", from: "index.md"), .data(URL(string: "data:image/png;base64,AAAA")!))
        XCTAssertEqual(ArtifactMarkdown.resolve("mailto:a@example.com", from: "index.md"), .external(URL(string: "mailto:a@example.com")!))
        XCTAssertEqual(ArtifactMarkdown.resolve("https:///nohost", from: "index.md"), .refused)
        // A one-letter "scheme" is a path, as a drive letter would be.
        XCTAssertEqual(ArtifactMarkdown.resolve("c:chart.png", from: "index.md"), file("c:chart.png"))
    }

    func testPrepareMovesInlinePicturesOntoTheirOwnLines() {
        let prepared = ArtifactMarkdown.prepare("Before ![one](a.png) middle ![two](b.png) after\n\n![three](c.png)")
        XCTAssertEqual(prepared, "Before\n![one](a.png)\nmiddle\n![two](b.png)\nafter\n\n![three](c.png)")
        XCTAssertEqual(ArtifactMarkdown.pictures(prepared), ["a.png", "b.png", "c.png"])
    }

    func testPrepareReadsHTMLPictures() {
        let prepared = ArtifactMarkdown.prepare(#"<p align="center"><img src="images/logo.png" alt="Logo" width="200"></p>"# + "\n" + #"<video controls src='clip.mp4'></video>"# + "\n<source src=\"b.webm\" type=\"video/webm\">")
        XCTAssertEqual(ArtifactMarkdown.pictures(prepared), ["<images/logo.png>", "<clip.mp4>", "<b.webm>"])
        XCTAssertTrue(prepared.contains("![Logo](<images/logo.png>)"))
        XCTAssertFalse(prepared.contains("<p"))
    }

    func testPrepareJoinsSoftBreaksAndKeepsCode() {
        let prepared = ArtifactMarkdown.prepare("one\ntwo ![x](a.png)\n\n```\n![not](code.png)\n```\nuse `![y](b.png)` here")
        XCTAssertEqual(prepared, "one two\n![x](a.png)\n\n```\n![not](code.png)\n```\nuse `![y](b.png)` here")
        XCTAssertEqual(ArtifactMarkdown.pictures(prepared), ["a.png"])
    }

    func testPrepareLinkedPictureAndParentheses() {
        let prepared = ArtifactMarkdown.prepare("[![badge](b.svg)](https://example.com) and ![p](chart(1).png)")
        XCTAssertEqual(ArtifactMarkdown.pictures(prepared), ["b.svg", "chart%281%29.png"])
        XCTAssertEqual(ArtifactMarkdown.resolve("chart%281%29.png", from: "index.md"), file("chart(1).png"))
    }

    func testPrepareLeavesTablesAlone() {
        let table = "| a | ![x](a.png) |\n| --- | --- |"
        XCTAssertEqual(ArtifactMarkdown.prepare(table), table)
    }
}
