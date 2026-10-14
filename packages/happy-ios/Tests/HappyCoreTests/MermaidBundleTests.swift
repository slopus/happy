import Foundation
import HappyCrypto
import XCTest

/// The chat's diagrams run the mermaid that ships in the app
/// (`Sources/HappyUI/Resources/Mermaid`), never one fetched at runtime. These
/// pin it to the exact file of the version happy-app's lockfile resolves,
/// with its license beside it, and keep the page from reaching the network.
final class MermaidBundleTests: XCTestCase {
    private let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../Sources/HappyUI/Resources/Mermaid")
        .standardizedFileURL

    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    /// `pnpm-lock.yaml`: mermaid@11.12.2, whose tarball's
    /// `dist/mermaid.min.js` has this SRI digest.
    func testTheScriptIsMermaid11_12_2AsPublished() throws {
        let script = try read("mermaid.min.js")
        XCTAssertEqual(
            Hashing.sha512(script).base64EncodedString(),
            "pMfvBKpWQkWCID8H+bisaGxxVlLfiDoBM0Skal8gc+vtOjCxEh0Hz5nfRoKoEaB8FwJcWx5Wp21MycoWu01uuw=="
        )
        XCTAssertNotNil(String(decoding: script, as: UTF8.self).range(of: #"name:"mermaid",version:"11.12.2""#))
    }

    func testItsLicenseShipsWithIt() throws {
        XCTAssertEqual(
            Hashing.sha512(try read("mermaid-LICENSE.txt")).base64EncodedString(),
            "j1nVj+EHsxj9fhPnaz+ao27/UlfwTu2YuH0Npfnbna2DLib3BQr1yItmNLtp6mDmOQ7FVUhlwBbKjphYCg1OUw=="
        )
        // The notices of what mermaid bundles stay in the script itself.
        let script = String(decoding: try read("mermaid.min.js"), as: UTF8.self)
        XCTAssertNotNil(script.range(of: "Bundled license information:"))
        XCTAssertNotNil(script.range(of: "@license DOMPurify 3.2.6"))
    }

    func testThePageLoadsOnlyTheAppsOwnScriptAndTakesItsDiagramAsAValue() throws {
        let page = String(decoding: try read("mermaid.html"), as: UTF8.self)
        XCTAssertNotNil(page.range(of: #"<script src="mermaid.min.js"></script>"#))
        XCTAssertNil(page.range(of: "cdn."), "no CDN")
        XCTAssertNil(page.range(of: "https://"))
        XCTAssertNotNil(page.range(of: "connect-src 'none'"))
        XCTAssertNotNil(page.range(of: "async function render(content, theme, background, token)"))
        XCTAssertNotNil(page.range(of: "window.webkit.messageHandlers.mermaid.postMessage"))
        // An error is shown as text, never as markup.
        XCTAssertNotNil(page.range(of: "message.textContent = 'Diagram error: '"))
        XCTAssertNotNil(page.range(of: "padding: 16px;"))
    }
}
