import Foundation
import HappyCore

/// A slow server: every request waits until the test lets them all go,
/// then gets `status` and `body`.
final class GatedHTTP: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let status: Int
    private let body: Data
    private var open = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var _requests: [HTTPRequest] = []
    private var answered = 0

    init(status: Int, body: String = "") {
        self.status = status
        self.body = Data(body.utf8)
    }

    var requests: [HTTPRequest] { lock.withLock { _requests } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        await withCheckedContinuation { (next: CheckedContinuation<Void, Never>) in
            let go = lock.withLock {
                _requests.append(request)
                if !open { waiting.append(next) }
                return open
            }
            if go { next.resume() }
        }
        lock.withLock { answered += 1 }
        return HTTPResponse(status: status, body: body)
    }

    /// Lets every request, waiting or still to come, through.
    func release() {
        let waiting = lock.withLock {
            open = true
            defer { self.waiting = [] }
            return self.waiting
        }
        for next in waiting { next.resume() }
    }

    /// Returns once `count` requests are waiting or through.
    func started(_ count: Int) async {
        while requests.count < count { await Task.yield() }
    }

    /// Returns once `count` requests have been answered.
    func finished(_ count: Int) async {
        while lock.withLock({ answered }) < count { await Task.yield() }
    }
}

/// A wait the test opens: whatever waits on it is held until `open`.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var arrivals = 0

    func wait() async {
        await withCheckedContinuation { (next: CheckedContinuation<Void, Never>) in
            let go = lock.withLock {
                arrivals += 1
                if !isOpen { waiting.append(next) }
                return isOpen
            }
            if go { next.resume() }
        }
    }

    func open() {
        let waiting = lock.withLock {
            isOpen = true
            defer { self.waiting = [] }
            return self.waiting
        }
        for next in waiting { next.resume() }
    }

    func arrived(_ count: Int) async {
        while lock.withLock({ arrivals }) < count { await Task.yield() }
    }
}
