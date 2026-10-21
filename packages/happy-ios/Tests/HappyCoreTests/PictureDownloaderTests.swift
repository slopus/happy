import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import HappyCore

private struct Unchecked<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// Serves `PictureStub.answers` by path, a chunk at a time, and records
/// what each request carried and whether it was stopped.
private final class PictureStub: URLProtocol, @unchecked Sendable {
    struct Answer {
        var status = 200
        var chunks: [Data]
        /// Between chunks, so a download can be stopped part way.
        var gap: TimeInterval = 0
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answers: [String: Answer] = [:]
    nonisolated(unsafe) private static var stopped: Set<String> = []
    nonisolated(unsafe) private static var sent: [String: Int] = [:]
    nonisolated(unsafe) private static var requests: [String: URLRequest] = [:]

    static func answer(_ path: String, _ answer: Answer) {
        lock.withLock { answers[path] = answer }
    }

    static func wasStopped(_ path: String) -> Bool { lock.withLock { stopped.contains(path) } }
    static func chunksSent(_ path: String) -> Int { lock.withLock { sent[path] ?? 0 } }
    static func request(_ path: String) -> URLRequest? { lock.withLock { requests[path] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let answer = Self.lock.withLock({ Self.answers[url.path] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
            return
        }
        let path = url.path
        Self.lock.withLock { Self.requests[path] = request }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let stub = Unchecked(self)
        DispatchQueue.global().async {
            let protocolSelf = stub.value
            for chunk in answer.chunks {
                if Self.wasStopped(path) { return }
                protocolSelf.client?.urlProtocol(protocolSelf, didLoad: chunk)
                Self.lock.withLock { Self.sent[path, default: 0] += 1 }
                if answer.gap > 0 { Thread.sleep(forTimeInterval: answer.gap) }
            }
            if Self.wasStopped(path) { return }
            protocolSelf.client?.urlProtocolDidFinishLoading(protocolSelf)
        }
    }

    override func stopLoading() {
        guard let path = request.url?.path else { return }
        _ = Self.lock.withLock { Self.stopped.insert(path) }
    }
}

/// The pictures' own fetcher, through a real URLSession.
final class PictureDownloaderTests: XCTestCase {
    private func downloader() -> PictureDownloader {
        let configuration = PictureDownloader.configuration()
        configuration.protocolClasses = [PictureStub.self]
        return PictureDownloader(configuration: configuration)
    }

    private func url(_ path: String) -> URL {
        URL(string: "https://pictures.test\(path)")!
    }

    private let chunk = Data(repeating: 7, count: 16 * 1024)

    func testABodyWithinTheLimitArrivesWhole() async {
        PictureStub.answer("/small", .init(chunks: [chunk, chunk, Data([1, 2, 3])]))
        let data = await downloader().data(url("/small"), limit: 64 * 1024)
        XCTAssertEqual(data, chunk + chunk + Data([1, 2, 3]))
        let request = PictureStub.request("/small")
        XCTAssertNil(request?.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(request?.value(forHTTPHeaderField: "Authorization"))
    }

    func testABodyOfExactlyTheLimitArrives() async {
        PictureStub.answer("/exact", .init(chunks: Array(repeating: chunk, count: 4)))
        let data = await downloader().data(url("/exact"), limit: 4 * chunk.count)
        XCTAssertEqual(data?.count, 4 * chunk.count)
    }

    /// Stopped as it passes the limit, not read to the end and then
    /// checked.
    func testABodyPastTheLimitIsStoppedPartWay() async {
        PictureStub.answer("/large", .init(chunks: Array(repeating: chunk, count: 64), gap: 0.005))
        let data = await downloader().data(url("/large"), limit: 4 * chunk.count)
        XCTAssertNil(data)
        // URLSession reports the cancelled task before it stops the
        // protocol: on Darwin `stopLoading` comes a few milliseconds after
        // the answer, on its CustomProtocols thread.
        await eventually { PictureStub.wasStopped("/large") }
        XCTAssertLessThan(PictureStub.chunksSent("/large"), 64)
    }

    func testAnAnswerOtherThan2xxIsNothing() async {
        PictureStub.answer("/missing", .init(status: 404, chunks: [Data("not found".utf8)]))
        let data = await downloader().data(url("/missing"), limit: 1024)
        XCTAssertNil(data)
    }

    func testOnlyHTTPIsFetched() async {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("picture-\(UUID().uuidString)")
        try? Data("private".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let data = await downloader().data(file, limit: 1024)
        XCTAssertNil(data)
    }

    func testCancellingStopsTheDownload() async throws {
        PictureStub.answer("/slow", .init(chunks: Array(repeating: Data([1]), count: 200), gap: 0.01))
        let downloader = downloader()
        let url = url("/slow")
        let download = Task { await downloader.data(url, limit: 1024) }
        try await Task.sleep(for: .milliseconds(100))
        download.cancel()
        let data = await download.value
        XCTAssertNil(data)
        await eventually { PictureStub.wasStopped("/slow") }
        XCTAssertLessThan(PictureStub.chunksSent("/slow"), 200)
    }
}
