#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import WebKit
import XCTest

/// ChatMermaidView with WebKit's real page and the bundled mermaid: what the
/// page draws, the heights it reports, and which of those reach the row.
/// Needs WebKit's own processes, so it runs only in the simulator; the
/// page's files and the script's digest are checked on Linux by
/// MermaidBundleTests, the height arithmetic by ChatLayoutTests.
@MainActor
final class ChatMermaidViewTests: XCTestCase {
    private let fourBoxes = "graph TD\nA-->B\nB-->C\nC-->D"

    /// Every height a view reported, in order.
    private final class Reports {
        var all: [(diagram: ChatMermaid, height: CGFloat)] = []
    }

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// A shown window, light, with `view` in it.
    private func show(_ view: UIView) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.overrideUserInterfaceStyle = .light
        window.addSubview(view)
        window.isHidden = false
        return window
    }

    /// A diagram's box at a row's width, `height` tall, reporting into `reports`.
    private func box(height: CGFloat = 200, _ reports: Reports) -> ChatMermaidView {
        let view = ChatMermaidView(frame: CGRect(x: 16, y: 100, width: 361, height: height))
        view.onHeight = { reports.all.append(($0, $1)) }
        return view
    }

    /// Waits up to `seconds` for `condition`, giving the run loop to WebKit.
    @discardableResult
    private func until(_ seconds: Double = 20, _ condition: () async throws -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try await condition() { return true }
            try await Task.sleep(for: .milliseconds(20))
        }
        return try await condition()
    }

    /// What `body` returns, run as one of the page's own scripts.
    private func script(_ view: ChatMermaidView, _ body: String) async throws -> Any? {
        let webView = try XCTUnwrap(view.webView, "the view made no page")
        return try await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
    }

    /// The id of the svg the page shows, `mermaid-diagram-<render>`; empty
    /// while it shows none, or is not there yet.
    private func drawn(_ view: ChatMermaidView) async -> String {
        let id = try? await script(view, "const svg = document.querySelector('#mermaid-container svg'); return svg ? svg.id : ''")
        return id as? String ?? ""
    }

    /// Waits for `view`'s render number `render` to be drawn and to report.
    private func rendered(_ view: ChatMermaidView, _ render: Int, _ reports: Reports, file: StaticString = #filePath, line: UInt = #line) async throws {
        let shown = try await until { await self.drawn(view) == "mermaid-diagram-\(render)" }
        let page = try? await script(view, "return document.body.innerText.slice(0, 200)")
        XCTAssertTrue(shown, "render \(render) never drew; the page shows \(String(describing: page))", file: file, line: line)
        let reported = try await until { !reports.all.isEmpty }
        XCTAssertTrue(reported, "render \(render) drew but reported no height", file: file, line: line)
    }

    /// The lightness of a CSS `rgb(…)` or `rgba(…)`, 0 to 255.
    private func lightness(_ css: String?) -> Double? {
        let channels = (css ?? "").split { !"0123456789.".contains($0) }.compactMap { Double($0) }
        guard channels.count >= 3 else { return nil }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }

    // MARK: Drawing

    func testTheBundledMermaidDrawsTheDiagramAndReportsHowTallItIs() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        let diagram = ChatMermaid(row: "m1", index: 0, content: fourBoxes)
        view.apply(diagram)
        try await rendered(view, 1, reports)

        let boxes = try await script(view, "return document.querySelectorAll('#mermaid-container svg .node').length") as? Int
        XCTAssertEqual(boxes, 4)
        XCTAssertTrue(reports.all.allSatisfy { $0.diagram == diagram })
        // Four boxes in a column and the page's 16 around them: more than the
        // box starts at, less than its cap.
        let height = try XCTUnwrap(reports.all.last?.height)
        XCTAssertGreaterThan(height, MarkdownLayout.Metrics.mermaidInitialHeight)
        XCTAssertLessThan(height, MarkdownLayout.Metrics.mermaidMaxHeight)
    }

    func testABrokenDiagramShowsItsErrorAsTextAndStillReportsAHeight() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        view.apply(ChatMermaid(row: "m1", index: 0, content: "<b id=\"injected\">not a diagram</b>"))
        let reported = try await until { !reports.all.isEmpty }
        XCTAssertTrue(reported, "the error drew no report")

        let error = try await script(view, "const error = document.querySelector('#mermaid-container .error'); return error ? error.textContent : ''") as? String
        XCTAssertTrue(error?.hasPrefix("Diagram error: ") == true, "the page shows \(String(describing: error))")
        XCTAssertGreaterThan(error?.count ?? 0, "Diagram error: ".count, "mermaid's own message follows")
        let noDiagram = try await script(view, "return document.querySelector('#mermaid-container svg') === null") as? Bool
        XCTAssertEqual(noDiagram, true)
        let noMarkup = try await script(view, "return document.getElementById('injected') === null") as? Bool
        XCTAssertEqual(noMarkup, true, "the diagram's text is never markup")
        XCTAssertGreaterThan(try XCTUnwrap(reports.all.last?.height), 2 * MarkdownLayout.Metrics.mermaidPadding)
    }

    func testADarkScreenDrawsTheDiagramAgainInMermaidsDarkThemeOnTheDarkSurface() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        view.apply(ChatMermaid(row: "m1", index: 0, content: fourBoxes))
        try await rendered(view, 1, reports)
        let looks = """
            const shape = document.querySelector('#mermaid-container svg .node rect, #mermaid-container svg .node polygon, #mermaid-container svg .node path');
            return [document.body.style.backgroundColor, shape ? getComputedStyle(shape).fill : ''];
            """
        let light = try await script(view, looks) as? [String]

        reports.all.removeAll()
        window.overrideUserInterfaceStyle = .dark
        window.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        try await rendered(view, 2, reports)
        let dark = try await script(view, looks) as? [String]

        let lightSurface = try XCTUnwrap(lightness(light?.first), "no page background in \(String(describing: light))")
        let darkSurface = try XCTUnwrap(lightness(dark?.first), "no page background in \(String(describing: dark))")
        XCTAssertGreaterThan(lightSurface, darkSurface)
        let lightBoxes = try XCTUnwrap(lightness(light?.last), "no box fill in \(String(describing: light))")
        let darkBoxes = try XCTUnwrap(lightness(dark?.last), "no box fill in \(String(describing: dark))")
        XCTAssertGreaterThan(lightBoxes, darkBoxes, "mermaid's dark theme fills its boxes dark")
    }

    // MARK: Which reports count

    func testOnlyTheNewestRendersHeightReachesTheRow() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        view.apply(ChatMermaid(row: "m1", index: 0, content: fourBoxes))
        try await rendered(view, 1, reports)

        // Two edits in one go: the first is still drawing when the second
        // replaces it.
        let replaced = ChatMermaid(row: "m1", index: 0, content: "graph LR\nX-->Y")
        let newest = ChatMermaid(row: "m1", index: 0, content: "graph TD\nP-->Q")
        reports.all.removeAll()
        view.apply(replaced)
        view.apply(newest)
        try await rendered(view, 3, reports)
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertTrue(reports.all.allSatisfy { $0.diagram == newest }, "\(reports.all.map { $0.diagram.content })")

        // What the page posts for a replaced render is dropped; for the
        // current one, taken.
        _ = try await script(view, "window.webkit.messageHandlers.mermaid.postMessage({ token: 2, height: 999 }); return true")
        _ = try await script(view, "window.webkit.messageHandlers.mermaid.postMessage({ token: 3, height: 555 }); return true")
        try await until { reports.all.contains { $0.height == 555 } }
        XCTAssertTrue(reports.all.contains { $0.height == 555 && $0.diagram == newest })
        XCTAssertFalse(reports.all.contains { $0.height == 999 })

        // A view left without a diagram reports nothing, even for its last render.
        reports.all.removeAll()
        view.apply(nil)
        _ = try await script(view, "window.webkit.messageHandlers.mermaid.postMessage({ token: 3, height: 444 }); return true")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(reports.all.isEmpty)
    }

    // MARK: In a row

    func testTheRowGrowsToWhatItsPageReportsAndKeepsThePageWhenPlannedAgain() async throws {
        let text = "Here:\n\n```mermaid\n\(fourBoxes)\n```\n"
        let style = ChatRowStyle(render: .isolated())
        var input = ChatRowInput(item: .message(.agentText(AgentTextMessage(id: "m1", createdAt: 0, text: text))), style: style)
        func mermaid(_ plan: ChatRowPlan) -> (diagram: ChatMermaid, frame: CGRect)? {
            for case .mermaid(let diagram, let frame) in plan.items { return (diagram, frame) }
            return nil
        }
        let first = ChatRowRenderer.plan(input, width: 393)
        let planned = try XCTUnwrap(mermaid(first), "the fence is a diagram")
        XCTAssertEqual(planned.diagram.row, "m1")
        XCTAssertEqual(planned.diagram.index, 0)
        XCTAssertEqual(planned.diagram.content.trimmingCharacters(in: .newlines), fourBoxes)
        XCTAssertEqual(planned.frame.height, MarkdownLayout.Metrics.mermaidInitialHeight)

        let row = ChatPlanView(frame: CGRect(origin: .zero, size: first.size))
        var actions: [(row: String, index: Int, height: CGFloat)] = []
        row.onAction = { action in
            if case .mermaidHeight(let row, let index, let height) = action { actions.append((row, index, height)) }
        }
        let window = show(row)
        defer { window.isHidden = true }
        row.apply(first)
        let view = try XCTUnwrap(row.subviews.compactMap { $0 as? ChatMermaidView }.first)
        try await until { !actions.isEmpty }
        // The page reports again once its drawing has settled.
        try await Task.sleep(for: .milliseconds(600))
        let reported = try XCTUnwrap(actions.max { $0.height < $1.height }, "the row heard no height")
        XCTAssertEqual(reported.row, "m1")
        XCTAssertEqual(reported.index, 0)
        let page = try XCTUnwrap(view.webView)

        // What the chat keeps of it plans the row again, the box that tall.
        let kept = try XCTUnwrap(MarkdownLayout.mermaidHeightToKeep(reported: reported.height, kept: nil, scale: 3), "\(reported.height) grows the box")
        input.mermaid = [0: kept]
        let again = ChatRowRenderer.plan(input, width: 393)
        XCTAssertEqual(mermaid(again)?.frame.height, kept)
        XCTAssertEqual(again.size.height, first.size.height + kept - MarkdownLayout.Metrics.mermaidInitialHeight, accuracy: 1)
        row.frame.size = again.size
        actions.removeAll()
        row.apply(again)
        XCTAssertTrue(row.subviews.compactMap { $0 as? ChatMermaidView }.first === view)
        XCTAssertTrue(view.webView === page, "the page is kept, not loaded again")
        XCTAssertEqual(view.frame.height, kept, accuracy: 0.5)
        try await Task.sleep(for: .milliseconds(500))
        let unchanged = await drawn(view)
        XCTAssertEqual(unchanged, "mermaid-diagram-1", "the same diagram is not drawn again")
        XCTAssertTrue(actions.isEmpty)

        // Taken by another row, the same page draws that row's diagram and
        // reports for that row.
        let other = ChatRowInput(item: .message(.agentText(AgentTextMessage(id: "m2", createdAt: 0, text: text))), style: style)
        row.apply(ChatRowRenderer.plan(other, width: 393))
        try await until { actions.contains { $0.row == "m2" } }
        XCTAssertTrue(view.webView === page)
        let redrawn = await drawn(view)
        XCTAssertEqual(redrawn, "mermaid-diagram-2")
        XCTAssertEqual(Set(actions.map { $0.row }), ["m2"])
    }

    func testADiagramTallerThanTheCapScrollsInsideItsBox() async throws {
        let reports = Reports()
        let view = box(height: MarkdownLayout.Metrics.mermaidMaxHeight, reports)
        let window = show(view)
        defer { window.isHidden = true }
        let column = (0..<24).map { "N\($0)-->N\($0 + 1)" }.joined(separator: "\n")
        view.apply(ChatMermaid(row: "m1", index: 0, content: "graph TD\n" + column))
        try await rendered(view, 1, reports)

        let reported = try XCTUnwrap(reports.all.map { $0.height }.max())
        XCTAssertGreaterThan(reported, MarkdownLayout.Metrics.mermaidMaxHeight)
        XCTAssertEqual(MarkdownLayout.mermaidHeightToKeep(reported: reported, kept: nil, scale: 3), MarkdownLayout.Metrics.mermaidMaxHeight)
        let page = try XCTUnwrap(view.webView)
        XCTAssertEqual(page.frame.height, MarkdownLayout.Metrics.mermaidMaxHeight)
        let scrolls = try await until { page.scrollView.contentSize.height > page.bounds.height }
        XCTAssertTrue(scrolls, "the page is \(page.scrollView.contentSize.height) inside a box of \(page.bounds.height)")
    }

    // MARK: The page

    func testThePageReachesNothingButItsOwnFiles() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        view.apply(ChatMermaid(row: "m1", index: 0, content: fourBoxes))
        try await rendered(view, 1, reports)

        let scripts = try await script(view, "return Array.from(document.scripts).filter(s => s.src).map(s => s.src)") as? [String]
        XCTAssertEqual(scripts?.count, 1)
        XCTAssertTrue(scripts?.allSatisfy { $0.hasPrefix("file://") && $0.hasSuffix("/mermaid.min.js") } == true, "\(String(describing: scripts))")

        // The page's own policy refuses, before any network is tried.
        func refused(_ request: String) async throws -> String? {
            try await script(view, """
                return await new Promise(resolve => {
                    document.addEventListener('securitypolicyviolation', event => resolve(event.effectiveDirective), { once: true });
                    \(request);
                    setTimeout(() => resolve('allowed'), 3000);
                });
                """) as? String
        }
        let fetched = try await refused("fetch('https://example.com/diagram.json').catch(() => {})")
        XCTAssertEqual(fetched, "connect-src")
        let pictured = try await refused("new Image().src = 'https://example.com/diagram.png'")
        XCTAssertEqual(pictured, "img-src")

        // Nor does it go anywhere, not even to a file beside it.
        let url = try XCTUnwrap(view.webView?.url)
        _ = try await script(view, "location.href = 'mermaid-LICENSE.txt'; return true")
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertEqual(view.webView?.url, url)
        let stayed = await drawn(view)
        XCTAssertEqual(stayed, "mermaid-diagram-1")
    }

    func testAPageWebKitLetGoIsLoadedAgainAndDrawsTheDiagramAgain() async throws {
        let reports = Reports()
        let view = box(reports)
        let window = show(view)
        defer { window.isHidden = true }
        let diagram = ChatMermaid(row: "m1", index: 0, content: fourBoxes)
        view.apply(diagram)
        try await rendered(view, 1, reports)
        let page = try XCTUnwrap(view.webView)

        // As WebKit calls it when the page's process is gone.
        reports.all.removeAll()
        view.webViewWebContentProcessDidTerminate(page)
        try await rendered(view, 2, reports)
        XCTAssertTrue(view.webView === page)
        XCTAssertTrue(reports.all.allSatisfy { $0.diagram == diagram })
    }
}
#endif
