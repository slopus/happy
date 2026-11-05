@testable import HappyCore
import HappyWire
import XCTest

/// `<meta name="happy-page-mode" content="app">` in a page's head makes it
/// an app; how it is read, and remembered.
final class ArtifactPageModeTests: XCTestCase {
    func testOnlyTheAppMetaInTheHeadMakesAnApp() {
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<!doctype html><html><head><meta name="happy-page-mode" content="app"><title>Snake</title></head><body></body></html>"#), .app)
        // Any case, either quote, bare values, attributes in any order, spaces.
        XCTAssertEqual(ArtifactPageMode.declared(in: "<HEAD><META CONTENT=' App ' NAME='Happy-Page-Mode'></HEAD>"), .app)
        XCTAssertEqual(ArtifactPageMode.declared(in: "<meta name=happy-page-mode content=app>"), .app)
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta charset="utf-8"><meta name="happy-page-width" content="full"><meta name="happy-page-mode" content="app" />"#), .app)
        // Anything else is a page.
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta name="happy-page-mode" content="page">"#), .page)
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta name="happy-page-mode" content="application">"#), .page)
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta name="happy-page-width" content="full">"#), .page)
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta name="description" content="app">"#), .page)
        XCTAssertEqual(ArtifactPageMode.declared(in: ""), .page)
        // The first declaration counts.
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<meta name="happy-page-mode" content="page"><meta name="happy-page-mode" content="app">"#), .page)
        // Not in a comment, and not in the body.
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<!-- <meta name="happy-page-mode" content="app"> --><title>x</title>"#), .page)
        XCTAssertEqual(ArtifactPageMode.declared(in: #"<head></head><body><p>Write <meta name="happy-page-mode" content="app"> to make an app.</p>"#), .page)
        // A head cut off mid-character still reads.
        var cut = Data(#"<meta name="happy-page-mode" content="app"><title>é"#.utf8)
        cut.removeLast()
        XCTAssertEqual(ArtifactPageMode.declared(in: cut), .app)
    }

    func testTheCloseButtonsCornerIsDeclaredBesideTheMode() {
        XCTAssertEqual(ArtifactAppClose.declared(in: #"<meta name="happy-page-mode" content="app">"#), .topStart)
        for close in ArtifactAppClose.allCases {
            XCTAssertEqual(ArtifactAppClose.declared(in: #"<meta name="happy-app-close" content="\#(close.rawValue)">"#), close)
        }
        XCTAssertEqual(ArtifactAppClose.declared(in: "<META NAME='Happy-App-Close' CONTENT=' Top-End '>"), .topEnd)
        // Anything else is the default.
        XCTAssertEqual(ArtifactAppClose.declared(in: #"<meta name="happy-app-close" content="middle">"#), .topStart)
        XCTAssertEqual(ArtifactAppClose.declared(in: #"<meta name="happy-app-close" content="">"#), .topStart)
        XCTAssertEqual(ArtifactAppClose.declared(in: #"<body><meta name="happy-app-close" content="none">"#), .topStart)
        XCTAssertEqual(
            ArtifactPageDeclaration.declared(in: Data(#"<meta name="happy-app-close" content="none"><meta name="happy-page-mode" content="app">"#.utf8)),
            ArtifactPageDeclaration(mode: .app, close: .none)
        )
    }

    func testOnlyHTMLFilesArePages() {
        XCTAssertTrue(ArtifactPageMode.isPage(path: "index.html", mimeType: "application/octet-stream"))
        XCTAssertTrue(ArtifactPageMode.isPage(path: "game/Play.HTM", mimeType: ""))
        XCTAssertTrue(ArtifactPageMode.isPage(path: "page", mimeType: "text/html; charset=utf-8"))
        XCTAssertFalse(ArtifactPageMode.isPage(path: "notes.md", mimeType: "text/markdown"))
    }

    /// The start of the file is read once per version, and opening at the
    /// latest opens the newest version read.
    func testTheStartOfAVersionIsReadOnceAndRemembered() async throws {
        let transport = Recording(answers: [
            "/v0/artifacts/a1/versions/2/files/index.html": #"<head><meta name="happy-page-mode" content="app"><meta name="happy-app-close" content="bottom-end"></head>"#,
            "/v0/artifacts/a1/versions/3/files/index.html": "<head><title>Now a page</title></head>",
        ])
        let client = AgentClient(transport: transport, token: "x")
        XCTAssertNil(client.pageModes.app("a1", version: 2, opensLatest: false))
        let declared = try await client.artifactPage("a1", version: 2, path: "index.html")
        XCTAssertEqual(declared, ArtifactPageDeclaration(mode: .app, close: .bottomEnd))
        _ = try await client.artifactPage("a1", version: 2, path: "index.html")
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(transport.requests.first?.headers["Range"], "bytes=0-65535")
        XCTAssertEqual(client.pageModes.app("a1", version: 2, opensLatest: false), ArtifactPageModes.Read(version: 2, entry: "index.html", mode: .app, close: .bottomEnd))
        XCTAssertEqual(client.pageModes.app("a1", version: 2, opensLatest: true)?.version, 2)

        // A newer version that is a page: the latest is no app; version 2 still is.
        let newer = try await client.artifactPage("a1", version: 3, path: "index.html")
        XCTAssertEqual(newer.mode, .page)
        XCTAssertNil(client.pageModes.app("a1", version: 3, opensLatest: true))
        XCTAssertNotNil(client.pageModes.app("a1", version: 2, opensLatest: false))
        // Another file of a version isn't what opening the version opens.
        client.pageModes.remember("a1", version: 4, path: "other.html", declared: ArtifactPageDeclaration(mode: .app), isEntry: false)
        XCTAssertNil(client.pageModes.app("a1", version: 4, opensLatest: false))
    }

    func testOnlyAnHTMLArtifactOfFilesHasAnEntryToRead() {
        func object(_ fields: [String: JSONValue]) -> JSONValue {
            var base: [String: JSONValue] = [
                "id": .string("a1"), "type": .string("html"), "status": .string("active"), "latestVersion": .number(3),
                "entry": .object(["path": .string("index.html")]), "live": .null,
            ]
            for (key, value) in fields { base[key] = value }
            return .object(base)
        }
        XCTAssertEqual(References.entry(object([:]))?.version, 3)
        XCTAssertEqual(References.entry(object([:]))?.path, "index.html")
        XCTAssertNil(References.entry(object(["type": .string("markdown")])))
        XCTAssertNil(References.entry(object(["status": .string("deleted")])))
        XCTAssertNil(References.entry(object(["live": .object(["url": .string("http://localhost:5173/")])])))
        XCTAssertNil(References.entry(object(["entry": .null])))

        var references = References()
        references.apps["a1"] = 3
        XCTAssertTrue(references.isApp("a1", version: 1, opensLatest: true))
        XCTAssertTrue(references.isApp("a1", version: 3, opensLatest: false))
        XCTAssertFalse(references.isApp("a1", version: 2, opensLatest: false))
        XCTAssertFalse(references.isApp("b2", version: 3, opensLatest: true))
    }
}

/// Answers each path with its body, and keeps what was asked.
private final class Recording: AgentTransport, @unchecked Sendable {
    struct Request { var path: String; var headers: [String: String] }
    let answers: [String: String]
    private let lock = NSLock()
    private var asked: [Request] = []
    var requests: [Request] { lock.withLock { asked } }

    init(answers: [String: String]) { self.answers = answers }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        lock.withLock { asked.append(Request(path: path, headers: headers)) }
        guard let answer = answers[path] else { return HTTP1Response(status: 404) }
        return HTTP1Response(status: 206, headers: ["content-range": "bytes 0-\(answer.utf8.count - 1)/\(answer.utf8.count)"], body: Data(answer.utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    func reset() async {}
    func close() async {}
}
