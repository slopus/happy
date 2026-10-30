#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import WebKit
import XCTest

/// An HTML artifact shown inline: its page loads from the computer's files
/// (and Happy's `/api/v1/` styles), says it loaded, and measures its own
/// height. With `HAPPY_PREVIEW_DIR` set, it also writes what it drew.
@MainActor
final class HostedInlinePageTests: XCTestCase {
    nonisolated private static let html = """
    <!doctype html><html><head><link rel="stylesheet" href="/api/v1/style.css"><style>
    body { margin: 0; font-family: var(--happy-host-font); color: var(--happy-host-text, #fff); }
    .row { display: flex; gap: 4px; align-items: end; height: 48px; margin-bottom: 12px; }
    .row i { width: 6px; background: var(--happy-host-muted, #999); border-radius: 3px; animation: b 1s infinite alternate; }
    @keyframes b { from { height: 20%; } to { height: 100%; } }
    </style></head><body><div class="row"><i style="height:40%"></i><i style="height:80%"></i><i style="height:60%"></i></div>
    <div class="row"><i style="height:70%"></i><i style="height:30%"></i></div><p id="probe">Voice</p></body></html>
    """

    private final class Host: UIViewController, PageHosting {
        let pageClient: AgentClient
        var heights: [CGFloat] = []
        init(_ client: AgentClient) { pageClient = client; super.init(nibName: nil, bundle: nil) }
        required init?(coder: NSCoder) { fatalError() }
        func page(_ artifactId: String, measured height: CGFloat) { heights.append(height) }
    }

    private actor Files: AgentTransport {
        var paths: [String] = []
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            paths.append(path)
            if path.hasSuffix("/api/v1/style.css") { return HTTP1Response(status: 200, headers: ["content-type": "text/css"], body: Data(":root{}".utf8)) }
            if path.contains("/versions/2/files/index.html") {
                return HTTP1Response(status: 206, headers: ["content-type": "text/html; charset=utf-8", "content-range": "bytes 0-\(HostedInlinePageTests.html.utf8.count - 1)/\(HostedInlinePageTests.html.utf8.count)"], body: Data(HostedInlinePageTests.html.utf8))
            }
            return HTTP1Response(status: 404)
        }
        nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
        nonisolated func reset() async {}
        nonisolated func close() async {}
    }

    func testAnInlinePageLoadsFromTheComputerAndMeasuresItself() async throws {
        let files = Files()
        let host = Host(AgentClient(transport: files, token: "test"))
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: host)
        window.overrideUserInterfaceStyle = .dark
        defer { window.isHidden = true }
        host.view.backgroundColor = UIColor(Palette.surface)
        let view = InlinePageView(frame: CGRect(x: 16, y: 100, width: 361, height: ChatPlanner.pageHeight))
        host.view.addSubview(view)
        view.apply(InlinePage(artifactId: "art1", title: "Voice waveform", page: .init(version: 2, entry: "index.html")))

        let deadline = Date().addingTimeInterval(15)
        while (view.accessibilityValue != "loaded" || host.heights.isEmpty), Date() < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(view.accessibilityIdentifier, "artifact-inline")
        XCTAssertEqual(view.accessibilityValue, "loaded")
        XCTAssertEqual(view.accessibilityLabel, "Voice waveform")
        let web = try XCTUnwrap(view.subviews.compactMap { $0 as? WKWebView }.first)
        // Laid out at the frame's width, a CSS pixel a point.
        let width = try await web.evaluateJavaScript("window.innerWidth") as? Double
        XCTAssertEqual(width, 361)
        // Two 48pt rows, each with 12 under it, then the paragraph's 16pt line and its margins.
        let height = try XCTUnwrap(host.heights.last)
        XCTAssertGreaterThan(height, 140)
        XCTAssertLessThan(height, 200)
        let paths = await files.paths
        XCTAssertTrue(paths.contains { $0.contains("/v0/artifacts/art1/versions/2/files/index.html") }, "\(paths)")
        XCTAssertTrue(paths.contains("/v0/artifacts/art1/api/v1/style.css"), "\(paths)")

        // The host's colours reached the page, and it drew its bars.
        let probe = try await web.evaluateJavaScript("document.getElementById('probe').textContent") as? String
        XCTAssertEqual(probe, "Voice")
        let text = try await web.evaluateJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--happy-host-text')") as? String
        XCTAssertEqual(text?.trimmingCharacters(in: .whitespaces), "rgba(255, 255, 255, 1.0)")

        // The same page again loads nothing new.
        let before = await files.paths.count
        view.apply(InlinePage(artifactId: "art1", title: "Voice waveform", page: .init(version: 2, entry: "index.html")))
        try await Task.sleep(for: .milliseconds(300))
        let after = await files.paths.count
        XCTAssertEqual(before, after)

        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            view.frame.size.height = height
            try await Task.sleep(for: .milliseconds(300))
            let snapshot = try await web.takeSnapshot(configuration: nil)
            let canvas = UIGraphicsImageRenderer(size: CGSize(width: 393, height: height + 32)).image { context in
                UIColor(Palette.surface).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 393, height: height + 32))
                snapshot.draw(at: CGPoint(x: 16, y: 16))
            }
            try canvas.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("inline-page.png"))
        }
    }
}
#endif
