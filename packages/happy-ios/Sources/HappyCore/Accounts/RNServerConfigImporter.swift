import Foundation

/// A recovered RN server setting, or a request for the user to settle it
/// before this app can use the shared account's bearer token.
public enum ImportedAccountServer: Equatable, Sendable {
    case confirmed(URL)
    case needsConfirmation
}

/// Read-only import of react-native-mmkv 3's unencrypted `server-config`.
/// No migration writes to RN's files, including when their data is torn.
public enum RNServerConfigImporter {
    public static func readFromDocuments() -> ImportedAccountServer {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return .needsConfirmation
        }
        return read(directory: documents.appendingPathComponent("mmkv", isDirectory: true))
    }

    public static func read(directory: URL) -> ImportedAccountServer {
        let file = directory.appendingPathComponent("server-config")
        do {
            let data: Data
            do {
                data = try Data(contentsOf: file)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                return .confirmed(ServerConfig.defaultServerURL)
            }
            let metaURL = directory.appendingPathComponent("server-config.crc")
            let meta = FileManager.default.fileExists(atPath: metaURL.path) ? try Data(contentsOf: metaURL) : nil
            let string = try MMKVStringDecoder.string(forKey: "custom-server-url", data: data, metadata: meta)
            guard let string, !string.isEmpty else { return .confirmed(ServerConfig.defaultServerURL) }
            return .confirmed(try ServerConfig.validate(string))
        } catch {
            return .needsConfirmation
        }
    }
}

/// Decodes only the unencrypted, non-expiring MMKV map/string format used
/// by RN's server setting. It rejects incomplete records and CRC mismatches
/// instead of MMKV's greedy salvage, because a wrong host leaks a token.
public enum MMKVStringDecoder {
    public enum DecodeError: Error, Equatable, Sendable {
        case truncated, malformed, missingChecksum, checksumMismatch, unsupportedMetadata
    }

    public static func string(forKey key: String, data: Data, metadata: Data?) throws -> String? {
        let bytes = Array(data)
        let meta = metadata.map(Array.init)
        guard bytes.count >= 4 else { throw DecodeError.truncated }
        var size = Int(fixed32(bytes, at: 0))
        // MMKVMetaInfo.hpp: crc 0, version 4, vector 12, actualSize 28,
        // lastConfirmed 32..103, flags 104; sizeof on iOS is 112 bytes.
        if let meta, meta.count >= 112 {
            let version = fixed32(meta, at: 4)
            guard version < 6 else { throw DecodeError.unsupportedMetadata }
            if version >= 4, meta[104..<112].contains(where: { $0 != 0 }) {
                throw DecodeError.unsupportedMetadata
            }
            // MMKV_IO.cpp readActualSize: v3+ metadata overrides the header.
            if version >= 3 { size = Int(fixed32(meta, at: 28)) }
        }
        guard size <= bytes.count - 4 else { throw DecodeError.truncated }
        let region = Array(bytes[4..<(4 + size)])
        if let meta, meta.count >= 4 {
            // MMKV_IO.cpp checkDataValid/checkFileCRCValid: CRC32 starts at
            // seed 0 over the actual data region, excluding the size header.
            guard crc32(region) == fixed32(meta, at: 0) else { throw DecodeError.checksumMismatch }
        } else if size != 0 {
            // A nonempty file without a readable checksum cannot establish
            // that its apparent last record was fully committed.
            throw DecodeError.missingChecksum
        }
        guard size > 0 else { return nil }
        var input = Input(bytes: region)
        _ = try input.varint32() // MiniPBCoder's int32 item-size holder.
        var last: [UInt8]?
        while !input.isAtEnd {
            let keyBytes = try input.lengthPrefixed()
            guard let recordKey = String(bytes: keyBytes, encoding: .utf8), !recordKey.isEmpty else {
                throw DecodeError.malformed
            }
            let value = try input.lengthPrefixed()
            if recordKey == key { last = value.isEmpty ? nil : value }
        }
        guard let last else { return nil }
        // MMKV::getString -> CodedInputData::readString: the value contains
        // another varint byte length before its UTF-8 payload.
        var value = Input(bytes: last)
        let stringBytes = try value.lengthPrefixed()
        guard value.isAtEnd, let string = String(bytes: stringBytes, encoding: .utf8) else {
            throw DecodeError.malformed
        }
        return string
    }

    private static func fixed32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        (0..<4).reduce(0) { $0 | UInt32(bytes[offset + $1]) << ($1 * 8) }
    }

    /// IEEE CRC32, the same polynomial and seed convention as MMKV/zlib.
    static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xffff_ffff
        for byte in bytes {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                crc = (crc >> 1) ^ (crc & 1 == 0 ? 0 : 0xedb8_8320)
            }
        }
        return crc ^ 0xffff_ffff
    }

    private struct Input {
        var bytes: [UInt8]
        var position = 0
        var isAtEnd: Bool { position == bytes.count }

        mutating func varint32() throws -> UInt32 {
            var value: UInt32 = 0
            // readRawVarint32 allows up to 10 bytes for sign-extended int32.
            for index in 0..<10 {
                guard position < bytes.count else { throw DecodeError.truncated }
                let byte = bytes[position]
                position += 1
                if index < 5 { value |= UInt32(byte & 0x7f) << (index * 7) }
                if byte & 0x80 == 0 { return value }
            }
            throw DecodeError.malformed
        }

        mutating func lengthPrefixed() throws -> [UInt8] {
            let length = try varint32()
            guard length <= Int32.max else { throw DecodeError.malformed }
            guard Int(length) <= bytes.count - position else { throw DecodeError.truncated }
            let end = position + Int(length)
            defer { position = end }
            return Array(bytes[position..<end])
        }
    }
}
