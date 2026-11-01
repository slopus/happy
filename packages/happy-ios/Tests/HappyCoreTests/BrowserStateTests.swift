import Foundation
@testable import HappyCore
import XCTest

final class BrowserProgressTests: XCTestCase {
    func testStartsSmallTakesFurtherEstimatesAndFills() {
        var progress = BrowserProgress()
        XCTAssertEqual(progress.phase, .hidden)
        progress.begin()
        XCTAssertEqual(progress, Self.state(.loading, 0.1))
        progress.estimate(0.05)
        XCTAssertEqual(progress.value, 0.1, "WebKit's estimate never moves the bar back")
        progress.estimate(0.5)
        XCTAssertEqual(progress.value, 0.5)
        progress.estimate(0.3)
        XCTAssertEqual(progress.value, 0.5)
        progress.finish()
        XCTAssertEqual(progress, Self.state(.finishing, 1))
        progress.estimate(0.2)
        XCTAssertEqual(progress.value, 1)
        progress.hide()
        XCTAssertEqual(progress, Self.state(.hidden, 0))
    }

    func testTrickleSlowsTowardItsCeiling() {
        var progress = BrowserProgress()
        progress.trickle()
        XCTAssertEqual(progress.value, 0, "Nothing creeps while nothing loads")
        progress.begin()
        progress.trickle()
        XCTAssertEqual(progress.value, 0.1 + 0.6 * 0.06, accuracy: 1e-12)
        var last = progress.value
        var step = Double.infinity
        for _ in 0..<200 {
            progress.trickle()
            XCTAssertGreaterThanOrEqual(progress.value, last)
            XCTAssertLessThanOrEqual(progress.value - last, step)
            step = progress.value - last
            last = progress.value
        }
        XCTAssertLessThan(progress.value, BrowserProgress.trickleCeiling)
        progress.estimate(0.9)
        progress.trickle()
        XCTAssertEqual(progress.value, 0.9)
    }

    func testRedirectsAndReplacingLoadsKeepGoing() {
        var progress = BrowserProgress()
        progress.begin()
        progress.estimate(0.4)
        progress.begin()
        XCTAssertEqual(progress, Self.state(.loading, 0.4))
        progress.finish()
        progress.begin()
        XCTAssertEqual(progress, Self.state(.loading, 0.1), "A load after the last one finished starts again")
        progress.hide()
        progress.finish()
        XCTAssertEqual(progress.phase, .hidden, "Only a load under way fills")
    }

    private static func state(_ phase: BrowserProgress.Phase, _ value: Double) -> BrowserProgress {
        var progress = BrowserProgress()
        switch phase {
        case .hidden: break
        case .loading: progress.begin(); progress.estimate(value)
        case .finishing: progress.begin(); progress.finish()
        }
        return progress
    }
}

final class BrowserProblemTests: XCTestCase {
    private func url(_ code: Int, _ failing: String? = nil) -> NSError {
        NSError(domain: NSURLErrorDomain, code: code, userInfo: failing.flatMap(URL.init(string:)).map { [NSURLErrorFailingURLErrorKey: $0] } ?? [:])
    }

    func testCancelledAndReplacedLoadsSayNothing() {
        XCTAssertNil(BrowserProblem.navigation(url(NSURLErrorCancelled), refusal: nil, link: .offline))
        XCTAssertNil(BrowserProblem.navigation(NSError(domain: "WebKitErrorDomain", code: 102), refusal: nil, link: nil))
        XCTAssertNil(BrowserProblem.navigation(NSError(domain: "WebKitErrorDomain", code: 204), refusal: nil, link: nil))
        XCTAssertNil(BrowserProblem.navigation(CancellationError(), refusal: nil, link: nil))
    }

    func testSystemErrors() {
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorCannotFindHost), refusal: nil, link: .online), .hostNotFound)
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorCannotConnectToHost), refusal: nil, link: .online), .serverNotResponding)
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorTimedOut), refusal: nil, link: nil), .timedOut)
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorServerCertificateUntrusted), refusal: nil, link: .offline), .insecure)
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorNotConnectedToInternet), refusal: nil, link: nil), .noNetwork)
        XCTAssertEqual(BrowserProblem.navigation(url(NSURLErrorUnsupportedURL, "ftp://files.local/a"), refusal: nil, link: .online), .unsupported(scheme: "ftp"))
        XCTAssertEqual(BrowserProblem.navigation(NSError(domain: "kCFErrorDomainCFNetwork", code: 310), refusal: nil, link: .online), .computerUnreachable)
        let odd = NSError(domain: "Elsewhere", code: 7, userInfo: [NSLocalizedDescriptionKey: "Something odd"])
        XCTAssertEqual(BrowserProblem.navigation(odd, refusal: nil, link: .online), .other("Something odd"))
    }

    func testTheConnectionAndTheProxySayWhy() {
        let refused = url(NSURLErrorCannotConnectToHost)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: nil, link: .waitingForNetwork), .noNetwork)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: nil, link: .offline), .computerUnreachable)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: BrowserProxyRefusal(status: 502, code: "browser_proxy_upstream_refused"), link: .online), .serverNotResponding)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: BrowserProxyRefusal(status: 502, code: "browser_proxy_upstream_transport"), link: .syncing), .computerUnreachable)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: BrowserProxyRefusal(status: 504, code: "browser_proxy_upstream_timeout"), link: nil), .timedOut)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: BrowserProxyRefusal(status: 503, code: "browser_proxy_route_unavailable"), link: nil), .unavailable)
        XCTAssertEqual(BrowserProblem.navigation(refused, refusal: BrowserProxyRefusal(status: 403, code: "browser_proxy_upstream_refused"), link: nil), .unavailable)
    }

    func testMainFrameStatuses() {
        XCTAssertNil(BrowserProblem.response(status: 200, proxyError: nil, hasBody: true, link: nil))
        XCTAssertNil(BrowserProblem.response(status: 404, proxyError: nil, hasBody: true, link: nil), "The page's own error page shows")
        XCTAssertNil(BrowserProblem.response(status: 502, proxyError: nil, hasBody: true, link: nil), "So does a dev server's own gateway error")
        XCTAssertEqual(BrowserProblem.response(status: 404, proxyError: nil, hasBody: false, link: nil), .http(status: 404))
        XCTAssertEqual(BrowserProblem.response(status: 502, proxyError: "browser_proxy_upstream_transport", hasBody: true, link: .online), .serverNotResponding)
        XCTAssertEqual(BrowserProblem.response(status: 504, proxyError: "browser_proxy_upstream_timeout", hasBody: true, link: nil), .serverNotResponding)
        XCTAssertEqual(BrowserProblem.response(status: 502, proxyError: "browser_proxy_upstream_transport", hasBody: true, link: .offline), .computerUnreachable)
        XCTAssertEqual(BrowserProblem.response(status: 403, proxyError: "browser_proxy_forbidden", hasBody: true, link: nil), .http(status: 403))
    }

    func testOpening() {
        XCTAssertEqual(BrowserProblem.opening(BrowserError.unavailable, link: nil), .unavailable)
        XCTAssertEqual(BrowserProblem.opening(BrowserError.unavailable, link: .offline), .computerUnreachable)
        XCTAssertEqual(BrowserProblem.opening(URLError(.timedOut), link: .connecting), .computerUnreachable)
        XCTAssertEqual(BrowserProblem.opening(URLError(.timedOut), link: .waitingForNetwork), .noNetwork)
    }

    func testRefusalsAreKeptByHostUntilCleared() throws {
        let refusals = BrowserRefusals()
        let page = try XCTUnwrap(URL(string: "http://localhost:5173/a?b"))
        refusals.record(BrowserProxyRefusal(status: 502, code: "browser_proxy_upstream_refused"), for: try XCTUnwrap(BrowserPolicy.Authority(url: page)))
        XCTAssertEqual(refusals.last(for: page), BrowserProxyRefusal(status: 502, code: "browser_proxy_upstream_refused"))
        XCTAssertNil(refusals.last(for: try XCTUnwrap(URL(string: "http://localhost:3000/"))))
        refusals.clear()
        XCTAssertNil(refusals.last(for: page))
    }

    func testInPageAddresses() throws {
        for address in ["about:blank", "about:srcdoc", "data:text/html,hi", "blob:http://localhost/1", "javascript:void(0)"] {
            XCTAssertTrue(BrowserPolicy.isInPage(try XCTUnwrap(URL(string: address))), address)
        }
        XCTAssertFalse(BrowserPolicy.isInPage(try XCTUnwrap(URL(string: "mailto:a@b.c"))))
        XCTAssertFalse(BrowserPolicy.isInPage(try XCTUnwrap(URL(string: "http://localhost"))))
    }
}
