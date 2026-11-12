import Foundation
import HappyWire
#if canImport(Compression)
import Compression
#else
import CDecoders
#endif

/// The compressed answers a computer may send. The daemon compresses a large
/// JSON body (64 KiB and up) when asked; a list of a few hundred tasks then
/// crosses the tunnel at about a sixth of its size.
enum ContentCoding {
    /// What a request accepts: only what every build decodes.
    static let accepted = "br, gzip"
    /// The most a body, or one read of a stream, may grow to: the parser's
    /// own bound on a plain body.
    static let limit = 8 * 1024 * 1024

    /// A response's `content-encoding`, nil when it is plain; one this
    /// build can't decode throws.
    static func coding(_ headers: [String: String]) throws -> String? {
        guard let coding = headers["content-encoding"]?.trimmingCharacters(in: .whitespaces).lowercased(), coding != "identity" else { return nil }
        // Nothing asked for any other, so nothing can read it.
        guard ["br", "gzip", "x-gzip"].contains(coding) else { throw PairingError.invalidResponse }
        return coding
    }

    /// `response` as if it had been sent plain: its body decoded, no
    /// `content-encoding`, and its `content-length` the decoded body's.
    static func decoded(_ response: HTTP1Response, limit: Int = limit) throws -> HTTP1Response {
        guard let decoder = try coding(response.headers).map(ContentDecoder.init) else { return response }
        let body = try decoder.append(response.body, limit: limit)
        guard decoder.finished else { throw PairingError.invalidResponse }
        var headers = response.headers
        headers["content-encoding"] = nil
        if headers["content-length"] != nil { headers["content-length"] = String(body.count) }
        return HTTP1Response(status: response.status, headers: headers, body: body)
    }
}

/// A `br` or `gzip` body decoded as its bytes arrive: whole, or an event
/// stream the server flushes after each event.
final class ContentDecoder {
    private let gzip: Bool
    private let inflater: Inflater
    /// A gzip member's header until all of it is here, then its trailer.
    private var pending = Data()
    private var inBody: Bool
    private var size: UInt32 = 0
    private var ended = false
    /// The whole stream, and a gzip trailer that matches it, is in.
    private(set) var finished = false

    init(_ coding: String) throws {
        switch coding {
        case "br": gzip = false; inflater = try Inflater(.brotli)
        case "gzip", "x-gzip": gzip = true; inflater = try Inflater(.deflate)
        default: throw PairingError.invalidResponse
        }
        inBody = !gzip
    }

    /// What `bytes` decode to; past `limit` bytes out, a zip bomb, it throws.
    func append(_ bytes: Data, limit: Int) throws -> Data {
        guard !finished || bytes.isEmpty else { throw PairingError.invalidResponse }
        var input = bytes
        if !inBody {
            pending.append(input)
            guard let length = try Self.gzipHeader(pending) else { return Data() }
            input = pending.dropFirst(length)
            pending = Data()
            inBody = true
        }
        var output = Data()
        if !ended {
            let used: Int
            (output, used, ended) = try inflater.process(input, limit: limit)
            input = input.dropFirst(used)
            size &+= UInt32(truncatingIfNeeded: output.count)
        }
        if ended {
            guard gzip else { guard input.isEmpty else { throw PairingError.invalidResponse }; finished = true; return output }
            pending.append(input)
            guard pending.count <= 8 else { throw PairingError.invalidResponse }
            if pending.count == 8 {
                // The trailer: CRC-32, then the length; the tunnel already guards the bytes.
                guard pending.suffix(4).reversed().reduce(UInt32(0), { $0 << 8 | UInt32($1) }) == size else { throw PairingError.invalidResponse }
                finished = true
            }
        }
        return output
    }

    /// The length of the gzip header (RFC 1952) `data` starts with, or nil
    /// until all of it has arrived.
    static func gzipHeader(_ data: Data) throws -> Int? {
        let bytes = [UInt8](data.prefix(32768))
        guard bytes.count >= 10 else { return nil }
        guard bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 8 else { throw PairingError.invalidResponse }
        let flags = bytes[3]
        var cursor = 10
        if flags & 0x04 != 0 {
            guard cursor + 2 <= bytes.count else { return nil }
            cursor += 2 + (Int(bytes[cursor]) | Int(bytes[cursor + 1]) << 8)
        }
        for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 {
            guard cursor < bytes.count, let end = bytes[cursor...].firstIndex(of: 0) else { return try more(bytes) }
            cursor = end + 1
        }
        if flags & 0x02 != 0 { cursor += 2 }
        guard cursor <= bytes.count else { return try more(bytes) }
        return cursor
    }

    /// A header not yet whole, unless it has run past any real one.
    private static func more(_ bytes: [UInt8]) throws -> Int? {
        guard bytes.count < 32768 else { throw PairingError.invalidResponse }
        return nil
    }
}

/// One raw deflate or Brotli stream, decoded as its bytes arrive.
final class Inflater {
    enum Algorithm { case brotli, deflate }

    private var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    #if canImport(Compression)
    private let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)

    init(_ algorithm: Algorithm) throws {
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, algorithm == .brotli ? COMPRESSION_BROTLI : COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            stream.deallocate(); throw PairingError.invalidResponse
        }
    }

    deinit { compression_stream_destroy(stream); stream.deallocate() }

    /// What `data` decodes to, how many of its bytes the stream took, and
    /// whether the stream has ended.
    func process(_ data: Data, limit: Int) throws -> (output: Data, used: Int, ended: Bool) {
        guard !data.isEmpty else { return (Data(), 0, false) }
        let input = [UInt8](data)
        var output = Data()
        return try input.withUnsafeBufferPointer { source in
            stream.pointee.src_ptr = source.baseAddress!
            stream.pointee.src_size = source.count
            while true {
                let before = stream.pointee.src_size
                let (status, produced) = buffer.withUnsafeMutableBufferPointer { out in
                    stream.pointee.dst_ptr = out.baseAddress!
                    stream.pointee.dst_size = out.count
                    let status = compression_stream_process(stream, 0)
                    return (status, out.count - stream.pointee.dst_size)
                }
                output.append(contentsOf: buffer[..<produced])
                guard output.count <= limit else { throw PairingError.invalidResponse }
                let used = source.count - stream.pointee.src_size
                if status == COMPRESSION_STATUS_END { return (output, used, true) }
                guard status == COMPRESSION_STATUS_OK else { throw PairingError.invalidResponse }
                guard produced < buffer.count else { continue }
                // All of it in and out: the rest needs more bytes.
                if stream.pointee.src_size == 0 { return (output, used, false) }
                guard stream.pointee.src_size < before else { throw PairingError.invalidResponse }
            }
        }
    }
    #else
    private let algorithm: Algorithm
    private let zlib = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)
    private let brotli: OpaquePointer?

    init(_ algorithm: Algorithm) throws {
        self.algorithm = algorithm
        zlib.initialize(to: z_stream())
        brotli = algorithm == .brotli ? BrotliDecoderCreateInstance(nil, nil, nil) : nil
        let ready = algorithm == .brotli ? brotli != nil : inflateInit2_(zlib, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
        guard ready else { zlib.deallocate(); throw PairingError.invalidResponse }
    }

    deinit {
        if algorithm == .deflate { inflateEnd(zlib) }
        zlib.deallocate()
        if let brotli { BrotliDecoderDestroyInstance(brotli) }
    }

    func process(_ data: Data, limit: Int) throws -> (output: Data, used: Int, ended: Bool) {
        guard !data.isEmpty else { return (Data(), 0, false) }
        let input = [UInt8](data)
        var output = Data()
        return try input.withUnsafeBufferPointer { source in
            switch algorithm {
            case .deflate:
                zlib.pointee.next_in = UnsafeMutablePointer(mutating: source.baseAddress)
                zlib.pointee.avail_in = UInt32(source.count)
                while true {
                    let (status, produced) = buffer.withUnsafeMutableBufferPointer { out in
                        zlib.pointee.next_out = out.baseAddress
                        zlib.pointee.avail_out = UInt32(out.count)
                        let status = inflate(zlib, Z_NO_FLUSH)
                        return (status, out.count - Int(zlib.pointee.avail_out))
                    }
                    output.append(contentsOf: buffer[..<produced])
                    guard output.count <= limit else { throw PairingError.invalidResponse }
                    let used = source.count - Int(zlib.pointee.avail_in)
                    if status == Z_STREAM_END { return (output, used, true) }
                    // Nothing more to do until more bytes come.
                    if status == Z_BUF_ERROR, zlib.pointee.avail_in == 0 { return (output, used, false) }
                    guard status == Z_OK else { throw PairingError.invalidResponse }
                    if zlib.pointee.avail_in == 0, zlib.pointee.avail_out > 0 { return (output, used, false) }
                }
            case .brotli:
                var next = source.baseAddress
                var available = source.count
                while true {
                    let (result, produced) = buffer.withUnsafeMutableBufferPointer { out in
                        var nextOut = out.baseAddress
                        var availableOut = out.count
                        let result = BrotliDecoderDecompressStream(brotli, &available, &next, &availableOut, &nextOut, nil)
                        return (result, out.count - availableOut)
                    }
                    output.append(contentsOf: buffer[..<produced])
                    guard output.count <= limit else { throw PairingError.invalidResponse }
                    switch result {
                    case BROTLI_DECODER_RESULT_SUCCESS: return (output, source.count - available, true)
                    case BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: return (output, source.count, false)
                    case BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: continue
                    default: throw PairingError.invalidResponse
                    }
                }
            }
        }
    }
    #endif
}
