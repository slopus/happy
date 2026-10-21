import Foundation
import XCTest
@testable import HappyCore

/// file.tsx's loading, decoding and view choice.
final class FileViewerTests: XCTestCase {
    let root = "/Users/me/repo"

    func testTarget() {
        let inside = FileViewer.Target(rawPath: "src/app.ts", sessionPath: root)
        XCTAssertEqual(inside.filePath, "/Users/me/repo/src/app.ts")
        XCTAssertEqual(inside.gitDiffPath, "src/app.ts")
        XCTAssertEqual(inside.fileName, "app.ts")
        let outside = FileViewer.Target(rawPath: "/etc/hosts", sessionPath: root)
        XCTAssertNil(outside.gitDiffPath)
        let unresolved = FileViewer.Target(rawPath: "src/app.ts", sessionPath: nil)
        XCTAssertEqual(unresolved.filePath, "src/app.ts")
        XCTAssertEqual(FileViewer.Target(rawPath: "/", sessionPath: nil).fileName, "/")
    }

    func testHeaderPath() {
        XCTAssertEqual(FileViewer.headerPath("/a.ts", line: nil, column: 3), "/a.ts")
        XCTAssertEqual(FileViewer.headerPath("/a.ts", line: 0, column: nil), "/a.ts")
        XCTAssertEqual(FileViewer.headerPath("/a.ts", line: 12, column: nil), "/a.ts:12")
        XCTAssertEqual(FileViewer.headerPath("/a.ts", line: 12, column: 4), "/a.ts:12:4")
        XCTAssertEqual(FileViewer.headerPath("/a.ts", line: 12, column: 0), "/a.ts:12")
    }

    func testLanguageAndBinaryPaths() {
        XCTAssertEqual(FileViewer.language("a/b.TSX"), "typescript")
        XCTAssertEqual(FileViewer.language("x.rs"), "rust")
        XCTAssertNil(FileViewer.language("Makefile"))
        XCTAssertNil(FileViewer.language("notes.txt"))
        XCTAssertTrue(FileViewer.isBinaryPath("logo.PNG"))
        XCTAssertTrue(FileViewer.isBinaryPath("icon.svg"))
        XCTAssertFalse(FileViewer.isBinaryPath("a.ts"))
        // `split('.').pop()` of a name without a dot is the whole name.
        XCTAssertTrue(FileViewer.isBinaryPath("png"))
    }

    func testAtob() {
        XCTAssertEqual(JSBase64.decode("aGk="), Data("hi".utf8))
        XCTAssertEqual(JSBase64.decode("aGk"), Data("hi".utf8))
        XCTAssertEqual(JSBase64.decode(" aG\nk= "), Data("hi".utf8))
        XCTAssertEqual(JSBase64.decode("aGl="), Data("hi".utf8), "leftover bits are dropped")
        XCTAssertNil(JSBase64.decode("aGk=="))
        XCTAssertNil(JSBase64.decode("aG="))
        XCTAssertNil(JSBase64.decode("a"))
        XCTAssertNil(JSBase64.decode("a-b_"))
        XCTAssertEqual(JSBase64.decode(""), Data())
        XCTAssertEqual(JSBase64.utf8(Data([0xEF, 0xBB, 0xBF, 0x41, 0xFF])), "A\u{FFFD}")
    }

    func testDecodeDecidesBinary() {
        func b64(_ bytes: [UInt8]) -> String { Data(bytes).base64EncodedString() }
        XCTAssertEqual(FileViewer.decode(base64: b64(Array("let x = 1\n".utf8))), .init(content: "let x = 1\n", isBinary: false))
        XCTAssertEqual(FileViewer.decode(base64: b64([0x41, 0x00, 0x42])), .init(content: "", isBinary: true))
        // 2 of 11 units are control characters: over a tenth.
        XCTAssertTrue(FileViewer.decode(base64: b64(Array("abcdefghi".utf8) + [1, 2])).isBinary)
        // 1 of 11: not.
        XCTAssertFalse(FileViewer.decode(base64: b64(Array("abcdefghij".utf8) + [1])).isBinary)
        XCTAssertFalse(FileViewer.decode(base64: b64(Array("\t\r\n".utf8))).isBinary)
        XCTAssertTrue(FileViewer.decode(base64: "%%%").isBinary)
    }

    func testDisplayMode() {
        XCTAssertEqual(FileViewer.displayMode(requestedLine: 5, hasDiff: true, hasContent: true, current: .diff), .file)
        XCTAssertEqual(FileViewer.displayMode(requestedLine: 0, hasDiff: true, hasContent: true, current: .file), .diff)
        XCTAssertEqual(FileViewer.displayMode(requestedLine: nil, hasDiff: false, hasContent: true, current: .diff), .file)
        XCTAssertEqual(FileViewer.displayMode(requestedLine: nil, hasDiff: false, hasContent: false, current: .diff), .diff)
        XCTAssertEqual(FileViewer.scrollOffset(line: 1), 0)
        XCTAssertEqual(FileViewer.scrollOffset(line: 10), 140)
    }

    func testBody() {
        let text = FileViewer.Content(content: "x", isBinary: false)
        let empty = FileViewer.Content(content: "", isBinary: false)
        XCTAssertEqual(FileViewer.Body(mode: .diff, diff: "+x", content: text), .diff)
        XCTAssertEqual(FileViewer.Body(mode: .file, diff: "+x", content: text), .code)
        XCTAssertEqual(FileViewer.Body(mode: .file, diff: "+x", content: empty), .fileEmpty)
        XCTAssertEqual(FileViewer.Body(mode: .file, diff: nil, content: nil), .noChanges)
        XCTAssertEqual(FileViewer.Body(mode: .diff, diff: nil, content: empty), .noChanges)
        XCTAssertEqual(FileViewer.Body(mode: .diff, diff: nil, content: text), .none)
        XCTAssertEqual(FileViewer.Body(mode: .file, diff: "+x", content: nil), .none)
    }

    func testDiffLines() {
        let lines = FileViewer.diffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n")
        XCTAssertEqual(lines.map(\.kind), [.context, .fileHeader, .fileHeader, .hunk, .removed, .added, .context, .context])
        XCTAssertEqual(lines.last?.text, " ")
        XCTAssertTrue(FileViewer.DiffLineKind.added.hasBar)
        XCTAssertFalse(FileViewer.DiffLineKind.hunk.hasBar)
        XCTAssertTrue(FileViewer.DiffLineKind.fileHeader.isBold)
        let crlf = FileViewer.diffLines("+a\r\n-\r\n")
        XCTAssertEqual(crlf.map(\.text), ["+a", "-", " "])
        XCTAssertEqual(crlf.map(\.kind), [.added, .removed, .context])
    }

    func testCodeLines() {
        // Without a language the file is one plain token, split by line.
        func codeLines(_ content: String, language: String?) -> [[SyntaxToken]] {
            FileViewer.codeLines(SyntaxHighlighter.tokenize(content, language: language))
        }
        XCTAssertEqual(codeLines("a\n\nb\n", language: nil), [
            [SyntaxToken("a", .plain)], [], [SyntaxToken("b", .plain)], [],
        ])
        let lines = codeLines("const x = f(1)\r\n// done", language: "typescript")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].map(\.text).joined(), "const x = f(1)")
        XCTAssertEqual(lines[0].first, SyntaxToken("const", .keyword))
        XCTAssertEqual(lines[0].first { $0.kind == .bracket }, SyntaxToken("(", .bracket, nestLevel: 1))
        XCTAssertEqual(lines[1], [SyntaxToken("// done", .comment)])
        // A line that is only a carriage return draws empty.
        XCTAssertEqual(codeLines("a\r\n\r\nb", language: nil).map { $0.map(\.text) }, [["a"], [], ["b"]])
    }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func add(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return values }
    }

    func transport(_ calls: Calls, diff: String, success: Bool = true, read: SessionReadFileResponse?) -> SessionShellTransport {
        SessionShellTransport(
            bash: { request in
                calls.add("bash \(request.command) cwd=\(request.cwd ?? "-") t=\(request.timeout ?? 0)")
                return SessionBashResponse(success: success, stdout: diff, stderr: "", exitCode: 0, error: nil)
            },
            readFile: { path in
                calls.add("read \(path)")
                guard let read else { throw SessionActionError.noAnswer }
                return read
            }
        )
    }

    func testLoadReadsDiffThenFile() async {
        let calls = Calls()
        let target = FileViewer.Target(rawPath: "src/a b.ts", sessionPath: root)
        let content = SessionReadFileResponse(success: true, content: Data("x\n".utf8).base64EncodedString(), error: nil)
        let result = await FileViewer.load(target, sessionPath: root, transport: transport(calls, diff: "+x\n", read: content))
        XCTAssertEqual(result, .loaded(.init(content: .init(content: "x\n", isBinary: false), diff: "+x\n")))
        XCTAssertEqual(calls.all, [
            "bash git diff --no-ext-diff -- \"src/a b.ts\" cwd=\(root) t=5000",
            "read \(root)/src/a b.ts",
        ])
    }

    func testLoadSkipsBlankDiffsAndPathsOutsideTheRoot() async {
        let calls = Calls()
        let content = SessionReadFileResponse(success: true, content: "eA==", error: nil)
        var result = await FileViewer.load(.init(rawPath: "a.ts", sessionPath: root), sessionPath: root, transport: transport(calls, diff: " \n", read: content))
        XCTAssertEqual(result, .loaded(.init(content: .init(content: "x", isBinary: false), diff: nil)))
        result = await FileViewer.load(.init(rawPath: "/etc/hosts", sessionPath: root), sessionPath: root, transport: transport(calls, diff: "+x", read: content))
        XCTAssertEqual(result, .loaded(.init(content: .init(content: "x", isBinary: false), diff: nil)))
        result = await FileViewer.load(.init(rawPath: "a.ts", sessionPath: root), sessionPath: root, transport: transport(calls, diff: "+x", success: false, read: content))
        XCTAssertEqual(result, .loaded(.init(content: .init(content: "x", isBinary: false), diff: nil)))
        XCTAssertEqual(calls.all.filter { $0.hasPrefix("bash") }.count, 2)
    }

    func testLoadFailuresAndBinaryPaths() async {
        let calls = Calls()
        let target = FileViewer.Target(rawPath: "a.ts", sessionPath: root)
        var result = await FileViewer.load(target, sessionPath: root, transport: transport(calls, diff: "+x", read: SessionReadFileResponse(success: false, content: nil, error: "denied")))
        XCTAssertEqual(result, .failed(.read("denied"), diff: "+x"))
        result = await FileViewer.load(target, sessionPath: root, transport: transport(calls, diff: "", read: SessionReadFileResponse(success: true, content: "", error: nil)))
        XCTAssertEqual(result, .failed(.read(nil), diff: nil))
        result = await FileViewer.load(target, sessionPath: root, transport: transport(calls, diff: "", read: nil))
        XCTAssertEqual(result, .failed(.load, diff: nil))
        let before = calls.all.count
        result = await FileViewer.load(.init(rawPath: "logo.png", sessionPath: root), sessionPath: root, transport: transport(calls, diff: "+x", read: nil))
        XCTAssertEqual(result, .loaded(.init(content: .init(content: "", isBinary: true), diff: nil)))
        XCTAssertEqual(calls.all.count, before, "binary extensions are never read")
    }

    func testCache() {
        let cache = SessionFileCache()
        XCTAssertNil(cache.get(sessionId: "s", path: "/a"))
        let snapshot = FileViewer.Snapshot(content: .init(content: "x", isBinary: false), diff: nil)
        cache.set(sessionId: "s", path: "/a", snapshot)
        XCTAssertEqual(cache.get(sessionId: "s", path: "/a"), snapshot)
        XCTAssertNil(cache.get(sessionId: "t", path: "/a"))
    }
}
