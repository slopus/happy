import Foundation

/// Tracks HTTP framing without buffering or decoding the body. The exact wire
/// bytes (including chunks and trailers) still go to WebKit. Never pool a socket
/// with unread response bytes or an ambiguous message boundary.
struct BrowserResponseBody {
    private enum State { case length(Int), size, chunk(Int), cr, lf, trailer, done, eof }
    private var state: State
    private var line = Data()
    private var trailerBytes = 0
    let permitsReuse: Bool

    init(head: BrowserHTTPHead, method: String) throws {
        let status = head.line.split(separator: " ")
        guard status.count >= 2, ["HTTP/1.0", "HTTP/1.1"].contains(status[0]),
              let code = Int(status[1]), (200...599).contains(code) else { throw BrowserError.malformed }
        let lengths = head.fields.filter { $0.0.lowercased() == "content-length" }
        let transfers = head.fields.filter { $0.0.lowercased() == "transfer-encoding" }
        guard lengths.count <= 1, transfers.count <= 1, lengths.isEmpty || transfers.isEmpty else { throw BrowserError.malformed }
        let close = head.fields.filter { $0.0.lowercased() == "connection" }
            .flatMap { $0.1.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }.contains("close")
        permitsReuse = status[0] == "HTTP/1.1" && !close && head.value("upgrade") == nil
            && (method == "HEAD" || code == 204 || code == 304 || !lengths.isEmpty || !transfers.isEmpty)
        if method == "HEAD" || code == 204 || code == 304 { state = .done }
        else if let transfer = transfers.first {
            guard transfer.1.lowercased() == "chunked" else { throw BrowserError.malformed }
            state = .size
        } else if let text = lengths.first?.1 {
            guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(text) else { throw BrowserError.malformed }
            state = count == 0 ? .done : .length(count)
        } else { state = .eof }
    }

    var finished: Bool { if case .done = state { return true }; return false }
    var reusable: Bool { finished && permitsReuse }

    mutating func append(_ bytes: Data) throws {
        var index = bytes.startIndex
        while index < bytes.endIndex {
            switch state {
            case .done: throw BrowserError.malformed
            case .eof: return
            case .length(let remaining), .chunk(let remaining):
                let count = min(remaining, bytes.endIndex - index)
                index += count
                if case .length = state { state = count == remaining ? .done : .length(remaining - count) }
                else { state = count == remaining ? .cr : .chunk(remaining - count) }
            case .cr:
                guard bytes[index] == 13 else { throw BrowserError.malformed }
                state = .lf; index += 1
            case .lf:
                guard bytes[index] == 10 else { throw BrowserError.malformed }
                state = .size; index += 1
            case .size, .trailer:
                line.append(bytes[index]); index += 1
                guard line.count <= 8192 else { throw BrowserError.tooLarge }
                if case .trailer = state {
                    trailerBytes += 1
                    guard trailerBytes <= 32768 else { throw BrowserError.tooLarge }
                }
                guard line.suffix(2) == Data([13, 10]) else { continue }
                if case .trailer = state {
                    if line.count == 2 { state = .done }
                    else {
                        // Reuse the strict field parser without altering trailers.
                        _ = try BrowserHTTPHead.parse(Data("HTTP/1.1 200 OK\r\n".utf8) + line + Data([13, 10]))
                    }
                } else {
                    let token = line.dropLast(2).prefix { $0 != 59 }
                    guard !token.isEmpty, token.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                          let count = Int(String(decoding: token, as: UTF8.self), radix: 16) else { throw BrowserError.malformed }
                    state = count == 0 ? .trailer : .chunk(count)
                }
                line.removeAll(keepingCapacity: true)
            }
        }
    }

    mutating func end() throws {
        if case .eof = state { state = .done; return }
        guard finished else { throw BrowserError.malformed }
    }
}