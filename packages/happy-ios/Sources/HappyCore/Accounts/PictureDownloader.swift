import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fetches pictures for `AccountPictures`: no cookies, credentials or
/// shared URL cache, so nothing of an account's goes with a request and
/// nothing fetched outlives the account's own cache. A response is read as
/// it arrives and dropped the moment it grows past its limit, never held
/// whole and checked after.
final class PictureDownloader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private final class Download {
        let limit: Int
        let continuation: CheckedContinuation<Data?, Never>
        var data = Data()
        var tooLarge = false

        init(limit: Int, continuation: CheckedContinuation<Data?, Never>) {
            self.limit = limit
            self.continuation = continuation
        }
    }

    private final class TaskBox: @unchecked Sendable {
        let task: URLSessionTask
        init(_ task: URLSessionTask) { self.task = task }
    }

    private let lock = NSLock()
    private var downloads: [Int: Download] = [:]
    // Set once in init. The session keeps its delegate (this) for as long
    // as it lives, which is as long as the account controller.
    private var session: URLSession!

    init(configuration: URLSessionConfiguration = PictureDownloader.configuration()) {
        super.init()
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        return configuration
    }

    /// The body of a 2xx answer for an http(s) `url`, or nil: any other
    /// answer, a failure, a body past `limit` bytes, or cancellation.
    func data(_ url: URL, limit: Int) async -> Data? {
        guard AccountPictures.isFetchable(url) else { return nil }
        let task = TaskBox(session.dataTask(with: URLRequest(url: url)))
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                lock.withLock {
                    downloads[task.task.taskIdentifier] = Download(limit: limit, continuation: continuation)
                }
                task.task.resume()
            }
        } onCancel: {
            task.task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let stop: Bool = lock.withLock {
            guard let download = downloads[dataTask.taskIdentifier], !download.tooLarge else { return false }
            guard download.data.count + data.count <= download.limit else {
                download.tooLarge = true
                download.data = Data()
                return true
            }
            download.data.append(data)
            return false
        }
        if stop { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let download = lock.withLock({ downloads.removeValue(forKey: task.taskIdentifier) }) else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let delivered = error == nil && !download.tooLarge && (200..<300).contains(status)
        download.continuation.resume(returning: delivered ? download.data : nil)
    }
}
