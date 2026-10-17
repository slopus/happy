import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?

    public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// The only thing that touches the network for HTTP. Tests replace it.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
    func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse
}

extension HTTPTransport {
    public func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse {
        let response = try await send(request)
        guard response.body.count <= limit else { throw URLError(.dataLengthExceedsMaximum) }
        return response
    }
}

public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    // URLSession is thread-safe.
    let session: URLSession
    private let imageDownloader = PictureDownloader()

    public convenience init() {
        self.init(session: NetworkSession.make())
    }

    /// Explicit sessions remain available to injected transports and tests.
    public init(session: URLSession) {
        self.session = session
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return HTTPResponse(status: http.statusCode, body: data)
    }

    public func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse {
        guard let response = await imageDownloader.response(request, limit: limit) else { throw URLError(.badServerResponse) }
        return response
    }
}
