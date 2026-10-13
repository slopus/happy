import Foundation
import HappyStore
import HappyWire

extension SessionActions {
    public static func supportsHappyAgentGit(_ metadata: JSONValue?) -> Bool {
        guard SessionMetadata.isRigV1(metadata), metadata?["capabilities"]?["files"]?["read"] == .bool(true),
              let methods = metadata?["capabilities"]?["rpcMethods"]?.arrayValue else { return false }
        return ["gitState", "readFile", "readFileAtRevision"].allSatisfy { methods.contains(.string($0)) }
    }

    private func requireHappyAgentGit(_ sessionId: String) throws {
        guard Self.supportsHappyAgentGit(try store.session(id: sessionId)?.metadata) else {
            throw SessionActionError.failed("Git changes are not available for this session.")
        }
    }

    public func getHappyAgentGitState(sessionId: String) async throws -> HappyAgentGitState {
        try requireHappyAgentGit(sessionId)
        let response = try await call(sessionId: sessionId, method: "gitState", params: .object([:])) ?? .null
        let invalid = "Happy Agent returned an invalid Git state."
        try gitValidateFailure(response, invalid: invalid)
        guard response["success"] == .bool(true), let git = response["git"] else {
            throw SessionActionError.failed(invalid)
        }
        return try HappyAgentGitState(git)
    }

    public func readHappyAgentGitFile(
        sessionId: String, gitBase: String, file: HappyAgentGitFile
    ) async throws -> HappyAgentFileContent {
        try requireHappyAgentGit(sessionId)
        guard gitRevision(gitBase) else {
            throw SessionActionError.failed("Happy Agent returned an invalid Git comparison base.")
        }
        switch file.status {
        case .conflicted: return .message("This file has unresolved conflicts and cannot be previewed.")
        case .submodule: return .message("Submodule changes cannot be previewed.")
        case .type_changed: return .message("This file changed type and cannot be previewed.")
        default: break
        }
        let before = file.status == .added || file.status == .untracked ? nil : file.previousPath ?? file.path
        let after = file.status == .deleted ? nil : file.path
        guard before != nil || after != nil else { return .message("This file has no readable comparison side.") }
        if file.binary, [before, after].compactMap({ $0 }).contains(where: { gitImageMIME($0) == nil }) {
            return .message("Binary file changes cannot be previewed.")
        }
        // Both calls settle before either error is surfaced, as in Promise.allSettled.
        async let oldResult = gitReadSide(sessionId: sessionId, path: before, revision: gitBase, after: false)
        async let newResult = gitReadSide(sessionId: sessionId, path: after, revision: gitBase, after: true)
        let (old, new) = await (oldResult, newResult)
        let oldContent = try old.get()
        let newContent = try new.get()
        if file.binary {
            var uris: [String?] = []
            for (path, content) in [(before, oldContent), (after, newContent)] {
                guard let path, let content else { uris.append(nil); continue }
                let (bytes, normalized) = try GitFileDecoding.inspectBase64(content)
                guard !bytes.isEmpty else { return .message("Image content is empty.") }
                guard let mime = gitImageMIME(path) else { return .message("Binary file changes cannot be previewed.") }
                uris.append("data:\(mime);base64,\(normalized)")
            }
            return .image(before: uris[0], after: uris[1])
        }
        return try GitFileDecoding.text(old: oldContent ?? "", new: newContent ?? "")
    }

    private func gitReadSide(
        sessionId: String, path: String?, revision: String, after: Bool
    ) async -> Result<String?, any Error> {
        guard let path else { return .success(nil) }
        do {
            let params: JSONValue = after ? .object(["path": .string(path)])
                : .object(["path": .string(path), "revision": .string(revision)])
            let response = try await call(sessionId: sessionId, method: after ? "readFile" : "readFileAtRevision", params: params) ?? .null
            let invalid = "Happy Agent returned an invalid file response."
            try gitValidateFailure(response, invalid: invalid)
            guard response["success"] == .bool(true), let content = response["content"]?.stringValue,
                  !after || gitHash(response["hash"]?.stringValue) else { throw SessionActionError.failed(invalid) }
            return .success(content)
        } catch { return .failure(error) }
    }
}

private func gitValidateFailure(_ value: JSONValue, invalid: String) throws {
    guard value["success"] == .bool(false) else { return }
    guard let code = value["code"]?.stringValue,
          ["invalid", "forbidden", "missing", "too_large", "unavailable", "unsupported"].contains(code),
          let error = value["error"]?.stringValue, !error.isEmpty else { throw SessionActionError.failed(invalid) }
    throw SessionActionError.failed(error)
}

private func gitHash(_ value: String?) -> Bool {
    guard let value else { return false }
    return value.utf8.count == 64 && gitRevision(value)
}

private func gitImageMIME(_ path: String) -> String? {
    guard let dot = path.lastIndex(of: ".") else { return nil }
    let suffix = String(path[path.index(after: dot)...]).lowercased()
    return ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
            "webp": "image/webp", "bmp": "image/bmp"][suffix]
}

/// Strict base64/UTF-8 limits shared by both comparison sides.
enum GitFileDecoding {
    static let maxBytes = 512 * 1024
    static let maxLines = 20000

    static func inspect(_ content: String) throws -> Data {
        try inspectBase64(content).data
    }

    static func inspectBase64(_ content: String) throws -> (data: Data, normalized: String) {
        // JavaScript's \s also includes BOM, but excludes Unicode NEL.
        let clean = String(String.UnicodeScalarView(content.unicodeScalars.filter { scalar in
            let value = scalar.value
            return !((9...13).contains(value) || (0x2000...0x200a).contains(value)
                || [0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].contains(value))
        }))
        let bytes = Array(clean.utf8)
        let padding = bytes.reversed().prefix(while: { $0 == 61 }).count
        let body = bytes.dropLast(padding)
        guard padding <= 2, body.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
            || (48...57).contains($0) || $0 == 43 || $0 == 47 }),
              padding == 0 || bytes.count % 4 == 0, bytes.count % 4 != 1 else {
            throw SessionActionError.failed("Happy Agent returned invalid file contents.")
        }
        let normalized = clean + String(repeating: "=", count: (4 - bytes.count % 4) % 4)
        let normalizedPadding = normalized.utf8.reversed().prefix(while: { $0 == 61 }).count
        let decodedSize = normalized.utf8.count / 4 * 3 - normalizedPadding
        guard decodedSize <= maxBytes else { throw SessionActionError.failed("This file is too large to preview on the phone.") }
        guard let data = Data(base64Encoded: normalized) else {
            throw SessionActionError.failed("Happy Agent returned invalid file contents.")
        }
        return (data, normalized)
    }

    static func text(old: String, new: String) throws -> HappyAgentFileContent {
        let oldData = try inspect(old)
        let newData = try inspect(new)
        guard let oldText = decodeUTF8(oldData) else { return .message("This file is not valid UTF-8 text.") }
        if oldText.contains("\0") { return .message("This file contains binary data and cannot be shown as text.") }
        guard let newText = decodeUTF8(newData) else { return .message("This file is not valid UTF-8 text.") }
        if newText.contains("\0") { return .message("This file contains binary data and cannot be shown as text.") }
        let oldLines = lines(oldData)
        guard oldLines <= maxLines, lines(newData) <= maxLines - oldLines else {
            return .message("This file has too many lines to preview here.")
        }
        return .text(oldText: oldText, newText: newText)
    }

    private static func lines(_ data: Data) -> Int {
        guard !data.isEmpty else { return 0 }
        return 1 + data.dropLast().reduce(0) { $0 + ($1 == 10 ? 1 : 0) }
    }

    private static func decodeUTF8(_ data: Data) -> String? {
        // Foundation consumes a BOM. Swift's decoder retains it, and byte-for-byte
        // round-trip validation rejects any malformed sequence it replaced.
        // This works on iOS 17, before String(validating:as:) became available.
        let text = String(decoding: data, as: UTF8.self)
        return text.utf8.elementsEqual(data) ? text : nil
    }
}
