import Foundation
import HappyWire
#if canImport(Compression)
import Compression
import zlib
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
    private let inflater: Inflater
    /// The whole stream is in, and nothing after it.
    private(set) var finished = false

    init(_ coding: String) throws {
        switch coding {
        case "br": inflater = try Inflater(.brotli)
        case "gzip", "x-gzip": inflater = try Inflater(.gzip)
        default: throw PairingError.invalidResponse
        }
    }

    /// What `bytes` decode to; past `limit` bytes out, a zip bomb, it throws.
    func append(_ bytes: Data, limit: Int) throws -> Data {
        guard !finished || bytes.isEmpty else { throw PairingError.invalidResponse }
        let (output, used, ended) = try inflater.process(bytes, limit: limit)
        if ended {
            guard used == bytes.count else { throw PairingError.invalidResponse }
            finished = true
        }
        return output
    }
}

/// One gzip or Brotli stream, decoded as its bytes arrive. gzip is zlib's
/// everywhere, header and trailer (CRC and length) included: Compression's
/// raw deflate reads past the stream's end into the trailer and can't say
/// where it stopped. Brotli is Compression's on Apple platforms.
final class Inflater {
    enum Algorithm { case brotli, gzip }

    private let algorithm: Algorithm
    private var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    private let zlib = UnsafeMutablePointer<z_stream>.allocate(capacity: 1)
    #if canImport(Compression)
    private let brotli = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    #else
    private let brotli: OpaquePointer?
    #endif

    init(_ algorithm: Algorithm) throws {
        self.algorithm = algorithm
        zlib.initialize(to: z_stream())
        #if canImport(Compression)
        let ready = algorithm == .brotli
            ? compression_stream_init(brotli, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI) == COMPRESSION_STATUS_OK
            : inflateInit2_(zlib, 15 + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
        guard ready else { zlib.deallocate(); brotli.deallocate(); throw PairingError.invalidResponse }
        #else
        brotli = algorithm == .brotli ? BrotliDecoderCreateInstance(nil, nil, nil) : nil
        let ready = algorithm == .brotli ? brotli != nil : inflateInit2_(zlib, 15 + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
        guard ready else { zlib.deallocate(); throw PairingError.invalidResponse }
        #endif
    }

    deinit {
        if algorithm == .gzip { inflateEnd(zlib) }
        zlib.deallocate()
        #if canImport(Compression)
        if algorithm == .brotli { compression_stream_destroy(brotli) }
        brotli.deallocate()
        #else
        if let brotli { BrotliDecoderDestroyInstance(brotli) }
        #endif
    }

    /// What `data` decodes to, how many of its bytes the stream took, and
    /// whether the stream has ended.
    func process(_ data: Data, limit: Int) throws -> (output: Data, used: Int, ended: Bool) {
        guard !data.isEmpty else { return (Data(), 0, false) }
        let input = [UInt8](data)
        var output = Data()
        return try input.withUnsafeBufferPointer { source in
            if algorithm == .gzip {
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
            }
            #if canImport(Compression)
            brotli.pointee.src_ptr = source.baseAddress!
            brotli.pointee.src_size = source.count
            while true {
                let before = brotli.pointee.src_size
                let (status, produced) = buffer.withUnsafeMutableBufferPointer { out in
                    brotli.pointee.dst_ptr = out.baseAddress!
                    brotli.pointee.dst_size = out.count
                    let status = compression_stream_process(brotli, 0)
                    return (status, out.count - brotli.pointee.dst_size)
                }
                output.append(contentsOf: buffer[..<produced])
                guard output.count <= limit else { throw PairingError.invalidResponse }
                let used = source.count - brotli.pointee.src_size
                if status == COMPRESSION_STATUS_END { return (output, used, true) }
                guard status == COMPRESSION_STATUS_OK else { throw PairingError.invalidResponse }
                guard produced < buffer.count else { continue }
                // All of it in and out: the rest needs more bytes.
                if brotli.pointee.src_size == 0 { return (output, used, false) }
                guard brotli.pointee.src_size < before else { throw PairingError.invalidResponse }
            }
            #else
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
            #endif
        }
    }
}
