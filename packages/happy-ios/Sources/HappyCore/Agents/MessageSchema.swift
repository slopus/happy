import Foundation
import HappyWire
#if canImport(OSLog)
import OSLog
#endif

/// A message checked against happy-agent-client's protocol schema
/// (`sources/protocol/messages.ts`) before the app reads it: its required
/// fields, their types and the closed sets of values the schema names,
/// roles and block types included. A message that fails is shown as one
/// placeholder row where it stands (`AgentWire.Message.unreadable`), never
/// at the cost of its neighbours. The shared protocol fixtures (desktop's
/// `fixtures/protocol-messages`, copied to `Tests/HappyCoreTests/Fixtures/ProtocolMessages`)
/// hold what passes and what fails.
///
/// What it leaves to the reader, on purpose:
/// - A presentation type it doesn't know: the call is a plain tool call,
///   rendered from its raw data (`Block`, `knownPresentations`), as an older
///   client reads a newer server. One of a known type with a bad shape
///   fails its message.
/// - Lengths, counts and numeric ranges: servers in use break some (the
///   cluster asks questions with `header: ""`).
/// - An optional field sent as `null` is taken as absent, and a person's
///   message's `mode` may be `null`: happy-agent sends that for one stored
///   before modes were kept.
/// - An `image` block's `data`: history may leave a large picture's bytes out.
/// - A tool call's `arguments` and `result` past being JSON: Cloud history
///   stored results as plain strings ("Message delivered.") before it
///   wrapped them, and that history stays as it was.
/// - A `review` without `elevated`: Cloud wrote verdicts without it before
///   it kept the pair; elevation is then unknown. `elevated` without a
///   `review`, or a malformed review, still fails.
/// - `error`, `failure` and `notice` past being objects: `Failure` reads
///   them, kinds it doesn't know included.
/// - A `gen_ui` document past being an object, and a media `tree` past its
///   `root` being a list: their own readers check them.
public enum MessageSchema {
    /// What kind of problem, as a fixed word a bug report may carry.
    public enum Code: String, Sendable {
        case missing, null
        case notString = "not_string", notBoolean = "not_boolean", notNumber = "not_number", notInteger = "not_integer"
        case notObject = "not_object", notList = "not_list", notStrings = "not_strings"
        case notOneOf = "not_one_of", unknownBlock = "unknown_block", unexpected = "unexpected_field"
        case unpaired, state, malformed
    }

    /// Why a message doesn't match the schema: where, as a JSON pointer
    /// into the message, and what is wrong. `problem` and `path` may hold
    /// what the message says (a value, a key it chose); `code` and
    /// `safePath`, where its own keys are `*`, never do.
    public struct Problem: Error, Equatable, Sendable, CustomStringConvertible {
        public var path: String
        public var problem: String
        public var code: Code
        public var safePath: String

        public init(path: String, problem: String, code: Code, safePath: String) {
            self.path = path
            self.problem = problem
            self.code = code
            self.safePath = safePath
        }

        public var description: String { path.isEmpty ? problem : "\(path): \(problem)" }

        /// `code` at `safePath`, e.g. `null at /content/1/presentation/answers`.
        public var summary: String { "\(code.rawValue) at \(safePath.isEmpty ? "/" : safePath)" }
    }

    /// Every problem found: one per field of the message, and the first in
    /// each block.
    public struct Problems: Error, Equatable, Sendable, CustomStringConvertible {
        public var all: [Problem]

        /// The first three, for a log line.
        public var description: String {
            let shown = all.prefix(3).map(\.description).joined(separator: "; ")
            return all.count > 3 ? "\(shown); and \(all.count - 3) more" : shown
        }

        /// The first, safely, and how many more.
        public var summary: String {
            guard let first = all.first else { return Code.malformed.rawValue }
            return all.count > 1 ? "\(first.summary) (+\(all.count - 1) more)" : first.summary
        }
    }

    /// Throws `Problems` for the message `decoder` reads, if it has any.
    public static func check(_ decoder: Decoder) throws {
        let message = try Object(decoder, path: "")
        var found: [Problem] = []
        func collect(_ step: () throws -> Void) {
            do { try step() } catch let problem as Problem { found.append(problem) } catch { found.append(Problem(path: "", problem: "\(error)", code: .malformed, safePath: "")) }
        }
        collect { _ = try message.string("id") }
        collect { _ = try message.integer("createdAt") }
        var role: String?
        collect { role = try message.oneOf("role", roles) }
        collect { try message.object("metadata", check: metadata) }
        collect {
            try message.array("content") { block, _ in collect { try check(block: block) } }
        }
        switch role {
        case "user":
            collect { _ = try message.oneOf("status", ["pending", "accepted"]) }
            collect { _ = try message.oneOf("delivery", ["queue", "steer"]) }
            // happy-agent sends `mode: null` on a person's message stored
            // before modes were kept (`ApiMessageProjection.messageResource`).
            collect { try message.nullable("mode") { try $0.object($1, check: mode) } }
            collect { _ = try message.nullableString("runId") }
            collect { try message.optionalNullable("profile") { _ = try $0.string($1) } }
            collect { try message.optionalObject("clientMetadata") { _ in } }
        case "service":
            collect { try message.optionalObject("error") { _ in } }
            collect { try message.optionalObject("failure") { _ in } }
            collect { try message.optionalObject("notice") { _ in } }
        default:
            break
        }
        if !found.isEmpty { throw Problems(all: found) }
    }

    /// The presentation types the schema has; any other is no presentation.
    static let knownPresentations: Set<String> = [
        "exploration", "exec_command", "background_terminal_interaction", "file_diff", "search", "agent_spawn",
        "media", "gen_ui", "artifact", "page", "user_input", "ui", "quick_replies",
    ]

    static let roles: Set<String> = ["user", "agent", "system", "service"]

    private static func metadata(_ metadata: Object) throws {
        for key in ["providerId", "modelId", "senderAgentId", "senderAgentExplanation", "userId"] {
            _ = try metadata.optionalString(key)
        }
    }

    private static func mode(_ mode: Object) throws {
        _ = try mode.string("providerId")
        _ = try mode.string("modelId")
        _ = try mode.string("effort")
        _ = try mode.nullableString("serviceTier")
        _ = try mode.oneOf("permissionMode", ["read_only", "workspace_write", "auto", "full_access"])
    }

    private static func check(block: Object) throws {
        switch try block.string("type") {
        case "text", "reasoning":
            _ = try block.string("text")
        case "image":
            _ = try block.string("mimeType")
            _ = try block.optionalString("data")
        case "file":
            _ = try block.string("attachment")
            _ = try block.string("name")
            for key in ["mimeType", "kind", "thumbhash"] { _ = try block.optionalString(key) }
            for key in ["size", "width", "height", "durationMs"] { _ = try block.optionalInteger(key) }
            _ = try block.optionalNumber("scale")
        case "tool_call_request":
            _ = try block.string("name")
            try block.optionalObject("arguments") { _ in }
            try block.only(["type", "name", "arguments"])
        case "tool_call":
            try toolCall(block)
        case "configuration":
            try block.nullable("before") { try $0.object($1, check: mode) }
            try block.object("after", check: mode)
            _ = try block.nullableString("beforeMessageId")
        case "compaction":
            try compaction(block)
        case "ui", "action", "quick_replies":
            // Retired, kept as opaque history.
            break
        case let type:
            throw block.problem("type", .unknownBlock, "\"\(type.prefix(40))\" is not a block type")
        }
    }

    private static func toolCall(_ block: Object) throws {
        _ = try block.string("id")
        _ = try block.string("name")
        _ = try block.oneOf("status", ["running", "completed", "failed"])
        // `arguments` and `result` are any JSON: Cloud history holds plain
        // strings from before it wrapped them.
        try block.optionalObject("presentation", check: presentation)
        // Review metadata comes as a pair. Cloud wrote a verdict without
        // `elevated` before it kept one; elevation is then unknown.
        let elevated = try block.optionalBool("elevated")
        if elevated != nil, !block.has("review") { throw block.problem("elevated", .unpaired, "comes without review") }
        try block.optionalObject("review") { review in
            _ = try review.string("reason")
            switch try review.oneOf("outcome", ["allowed", "denied", "unproven"]) {
            case "unproven":
                _ = try review.oneOf("kind", ["timed_out", "unavailable"])
            default:
                _ = try review.oneOf("risk", ["low", "medium", "high", "critical"])
                _ = try review.oneOf("userAuthorization", ["unknown", "low", "medium", "high"])
            }
        }
    }

    private static func compaction(_ block: Object) throws {
        _ = try block.oneOf("trigger", ["manual", "automatic"])
        try block.nullable("tokensBefore") { _ = try $0.integer($1) }
        _ = try block.integer("startedAt")
        let status = try block.oneOf("status", ["running", "completed", "failed"])
        try block.nullable("tokensAfter") { object, key in
            guard status == "completed" else { throw object.problem(key, .state, "is not null while \(status)") }
            _ = try object.integer(key)
        }
        try block.nullable("failureReason") { object, key in
            guard status == "failed" else { throw object.problem(key, .state, "is not null while \(status)") }
            _ = try object.string(key)
        }
        try block.nullable("completedAt") { object, key in
            guard status != "running" else { throw object.problem(key, .state, "is not null while running") }
            _ = try object.integer(key)
        }
        if status == "failed", try block.nullableString("failureReason") == nil { throw block.problem("failureReason", .state, "is null on a failed compaction") }
        if status != "running", !block.has("completedAt") { throw block.problem("completedAt", .state, "is null once settled") }
    }

    private static func presentation(_ presentation: Object) throws {
        switch try presentation.string("type") {
        case "exploration":
            try presentation.array("operations") { operation, _ in
                switch try operation.oneOf("kind", ["list", "read", "search"]) {
                case "list": _ = try operation.string("target")
                case "read": _ = try operation.string("name")
                default:
                    _ = try operation.string("command")
                    _ = try operation.optionalString("path")
                    _ = try operation.optionalString("query")
                }
            }
        case "exec_command":
            _ = try presentation.string("command")
            _ = try presentation.optionalString("output")
            _ = try presentation.optionalString("terminalId")
        case "background_terminal_interaction":
            _ = try presentation.string("command")
            _ = try presentation.string("input")
            _ = try presentation.string("terminalId")
        case "file_diff":
            try presentation.array("files") { file, _ in
                _ = try file.integer("added")
                _ = try file.integer("deleted")
                _ = try file.oneOf("kind", ["add", "delete", "update"])
                _ = try file.string("path")
                _ = try file.optionalString("language")
                _ = try file.optionalInteger("omittedLines")
                try file.array("hunks") { hunk, _ in
                    _ = try hunk.integer("newStart")
                    _ = try hunk.integer("oldStart")
                    try hunk.array("lines") { line, _ in
                        _ = try line.oneOf("kind", ["context", "add", "delete"])
                        _ = try line.string("text")
                    }
                }
            }
            _ = try presentation.optionalInteger("omittedFiles")
        case "search":
            _ = try presentation.string("query")
            _ = try presentation.oneOf("target", ["web", "x"])
            try presentation.optionalArray("sources") { source, _ in
                _ = try source.string("title")
                _ = try source.string("url")
            }
        case "agent_spawn":
            try presentation.optionalObject("model") { model in
                for key in ["modelId", "providerId", "name"] { _ = try model.string(key) }
            }
            _ = try presentation.optionalString("agentId")
        case "media":
            try presentation.array("items", check: mediaItem)
            // A layout this app doesn't know is the automatic one.
            try presentation.optionalObject("layout") { layout in
                switch try layout.string("type") {
                case "columns":
                    guard [1, 2].contains(try layout.integer("columns")) else { throw layout.problem("columns", .notOneOf, "is not 1 or 2") }
                case "tree": try layout.array("root") { _, _ in }
                default: break
                }
            }
        case "gen_ui":
            try presentation.object("document") { _ in }
        case "artifact":
            _ = try presentation.string("artifactId")
            _ = try presentation.integer("version")
            _ = try presentation.oneOf("artifactType", ["markdown", "html", "image", "image_series", "video", "document", "gen_ui"])
            _ = try presentation.string("title")
            // A `shows` this app doesn't know means "version".
            _ = try presentation.optionalString("shows")
        case "page":
            _ = try presentation.string("url")
            _ = try presentation.string("title")
            try presentation.nullable("display") { _ = try $0.oneOf($1, ["inline_compact", "inline_expanded", "side"]) }
        case "user_input":
            try presentation.array("questions") { question, _ in
                for key in ["id", "header", "question"] { _ = try question.string(key) }
                _ = try question.bool("multiSelect")
                try question.array("options") { option, _ in
                    _ = try option.string("label")
                    _ = try option.string("description")
                }
            }
            try presentation.object("answers") { answers in
                // Keyed by question IDs the message chose: `*` in a report.
                for key in answers.keys { try answers.strings(key, dynamic: true) }
            }
        default:
            // `ui` and `quick_replies` are opaque history; anything else is
            // no presentation, the call rendered from its raw data.
            break
        }
    }

    private static func mediaItem(_ item: Object, index: Int) throws {
        let kind = try item.string("kind")
        _ = try item.optionalString("id")
        _ = try item.string("name")
        _ = try item.string("mimeType")
        _ = try item.integer("size")
        if kind == "image" {
            _ = try item.integer("width")
            _ = try item.integer("height")
            _ = try item.string("thumbhash")
        } else {
            _ = try item.optionalInteger("width")
            _ = try item.optionalInteger("height")
            _ = try item.optionalInteger("durationMs")
            _ = try item.optionalString("thumbhash")
        }
        _ = try item.optionalNumber("scale")
        try item.optionalObject("source") { source in
            _ = try source.string("path")
            _ = try source.string("absolutePath")
        }
    }

    /// `message` with what the schema asks of a person's message, when it is
    /// one: accepted, queued, in a mode. For fixtures and harnesses that
    /// write messages by hand; what they already say is kept.
    public static func withUserFields(_ message: JSONValue) -> JSONValue {
        guard case .object(var object) = message, object["role"] == .string("user") else { return message }
        if !["pending", "accepted"].contains(object["status"]?.stringValue ?? "") { object["status"] = .string("accepted") }
        if object["delivery"] == nil { object["delivery"] = .string("queue") }
        if object["runId"] == nil { object["runId"] = object["status"] == .string("pending") ? .null : .string("run") }
        if object["mode"] == nil {
            object["mode"] = .object(["providerId": .string("claude"), "modelId": .string("opus"), "effort": .string("medium"), "serviceTier": .null, "permissionMode": .string("auto")])
        }
        return .object(object)
    }

    // MARK: Reading

    struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ string: String) { stringValue = string }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// One JSON object, read field by field without making a copy of it.
    struct Object {
        let container: KeyedDecodingContainer<Key>
        let path: String
        /// `path` with the keys the message chose as `*`.
        let safePath: String

        init(_ decoder: Decoder, path: String) throws {
            do { container = try decoder.container(keyedBy: Key.self) } catch { throw Problem(path: path, problem: "is not an object", code: .notObject, safePath: path) }
            self.path = path
            safePath = path
        }

        init(_ container: KeyedDecodingContainer<Key>, path: String, safePath: String) {
            self.container = container
            self.path = path
            self.safePath = safePath
        }

        var keys: [String] { container.allKeys.map(\.stringValue) }

        /// The JSON pointer to `key` (RFC 6901).
        func at(_ key: String) -> String { "\(path)/\(key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1"))" }

        /// `at(key)` for a report: `*` for a key the message chose
        /// (`dynamic`); the schema's own names are fixed.
        func safeAt(_ key: String, dynamic: Bool = false) -> String {
            dynamic ? "\(safePath)/*" : "\(safePath)/\(key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1"))"
        }

        func problem(_ key: String, _ code: Code, _ problem: String, dynamic: Bool = false) -> Problem {
            Problem(path: at(key), problem: problem, code: code, safePath: safeAt(key, dynamic: dynamic))
        }

        /// Present and not null.
        func has(_ key: String) -> Bool {
            let key = Key(key)
            return container.contains(key) && (try? container.decodeNil(forKey: key)) == false
        }

        private func required(_ key: String) throws {
            guard container.contains(Key(key)) else { throw problem(key, .missing, "is missing") }
            guard has(key) else { throw problem(key, .null, "is null") }
        }

        private func read<T: Decodable>(_ type: T.Type, _ key: String, _ code: Code, _ name: String) throws -> T {
            try required(key)
            do { return try container.decode(type, forKey: Key(key)) } catch { throw problem(key, code, "is not \(name)") }
        }

        func string(_ key: String) throws -> String { try read(String.self, key, .notString, "a string") }

        func bool(_ key: String) throws -> Bool { try read(Bool.self, key, .notBoolean, "a boolean") }

        func number(_ key: String) throws -> Double { try read(Double.self, key, .notNumber, "a number") }

        func integer(_ key: String) throws -> Double {
            let value = try number(key)
            guard value.rounded() == value else { throw problem(key, .notInteger, "is not an integer") }
            return value
        }

        func oneOf(_ key: String, _ values: Set<String>) throws -> String {
            let value = try string(key)
            guard values.contains(value) else { throw problem(key, .notOneOf, "\"\(value.prefix(40))\" is not one of \(values.sorted().joined(separator: ", "))") }
            return value
        }

        func optionalString(_ key: String) throws -> String? { has(key) ? try string(key) : nil }
        func optionalBool(_ key: String) throws -> Bool? { has(key) ? try bool(key) : nil }
        func optionalNumber(_ key: String) throws -> Double? { has(key) ? try number(key) : nil }
        func optionalInteger(_ key: String) throws -> Double? { has(key) ? try integer(key) : nil }

        /// Required, and either null or what `check` reads.
        func nullable(_ key: String, check: (Object, String) throws -> Void) throws {
            guard container.contains(Key(key)) else { throw problem(key, .missing, "is missing") }
            if has(key) { try check(self, key) }
        }

        func nullableString(_ key: String) throws -> String? {
            guard container.contains(Key(key)) else { throw problem(key, .missing, "is missing") }
            return has(key) ? try string(key) : nil
        }

        /// Absent, null, or what `check` reads.
        func optionalNullable(_ key: String, check: (Object, String) throws -> Void) throws {
            if has(key) { try check(self, key) }
        }

        func object(_ key: String, check: (Object) throws -> Void) throws {
            try required(key)
            let nested: KeyedDecodingContainer<Key>
            do { nested = try container.nestedContainer(keyedBy: Key.self, forKey: Key(key)) } catch { throw problem(key, .notObject, "is not an object") }
            try check(Object(nested, path: at(key), safePath: safeAt(key)))
        }

        func optionalObject(_ key: String, check: (Object) throws -> Void) throws {
            if has(key) { try object(key, check: check) }
        }

        func array(_ key: String, check: (Object, Int) throws -> Void) throws {
            try required(key)
            var list: UnkeyedDecodingContainer
            do { list = try container.nestedUnkeyedContainer(forKey: Key(key)) } catch { throw problem(key, .notList, "is not a list") }
            var index = 0
            while !list.isAtEnd {
                let path = "\(at(key))/\(index)", safePath = "\(safeAt(key))/\(index)"
                let element: KeyedDecodingContainer<Key>
                do { element = try list.nestedContainer(keyedBy: Key.self) } catch { throw Problem(path: path, problem: "is not an object", code: .notObject, safePath: safePath) }
                try check(Object(element, path: path, safePath: safePath), index)
                index += 1
            }
        }

        func optionalArray(_ key: String, check: (Object, Int) throws -> Void) throws {
            if has(key) { try array(key, check: check) }
        }

        /// A list of strings; `dynamic` when the message chose `key`.
        func strings(_ key: String, dynamic: Bool = false) throws {
            guard container.contains(Key(key)) else { throw problem(key, .missing, "is missing", dynamic: dynamic) }
            guard has(key) else { throw problem(key, .null, "is null", dynamic: dynamic) }
            do { _ = try container.decode([String].self, forKey: Key(key)) } catch { throw problem(key, .notStrings, "is not a list of strings", dynamic: dynamic) }
        }

        /// Fails on any field outside `allowed`.
        func only(_ allowed: Set<String>) throws {
            if let extra = keys.first(where: { !allowed.contains($0) }) { throw problem(extra, .unexpected, "is not allowed", dynamic: true) }
        }
    }

    // MARK: Reporting

    /// Why a message failed, in full, for the log: where, from the schema
    /// or, for what it let through, the decoder. It may quote the message
    /// (a value, a key it chose). `depth` is how deep the message sits in
    /// what was decoded.
    static func detail(_ error: Error, under depth: Int = 0) -> String {
        if let problems = error as? Problems { return problems.description }
        if let problem = error as? Problem { return problem.description }
        guard let (path, code) = decoding(error, under: depth, safe: false) else { return "\(type(of: error))" }
        return path.isEmpty ? code : "\(path): \(code)"
    }

    /// Why a message failed as a report may carry it: a fixed code and the
    /// path with every key the message chose as `*`
    /// (`null at /content/1/presentation/answers`). Never a value.
    static func summary(_ error: Error, under depth: Int = 0) -> String {
        if let problems = error as? Problems { return problems.summary }
        if let problem = error as? Problem { return problem.summary }
        guard let (path, code) = decoding(error, under: depth, safe: true) else { return Code.malformed.rawValue }
        return "\(code) at \(path.isEmpty ? "/" : path)"
    }

    /// A decoder's error as a path and a code; `safe` leaves only list
    /// indices and the schema's field names in the path.
    private static func decoding(_ error: Error, under depth: Int, safe: Bool) -> (path: String, code: String)? {
        guard let error = error as? DecodingError else { return nil }
        let context: DecodingError.Context
        let code: Code
        switch error {
        case .keyNotFound(_, let found): context = found; code = .missing
        case .valueNotFound(_, let found): context = found; code = .null
        case .typeMismatch(_, let found): context = found; code = .malformed
        case .dataCorrupted(let found): context = found; code = .malformed
        @unknown default: return ("", Code.malformed.rawValue)
        }
        var keys = Array(context.codingPath.dropFirst(depth))
        if case .keyNotFound(let key, _) = error { keys.append(key) }
        let path: String = keys.map { key -> String in
            if let index = key.intValue { return "/\(index)" }
            return safe && !fields.contains(key.stringValue) ? "/*" : "/\(key.stringValue)"
        }.joined()
        return (path, code.rawValue)
    }

    /// The field names the schema itself has; any other key in a decoder's
    /// path came from the message.
    static let fields: Set<String> = [
        "id", "createdAt", "role", "metadata", "content", "status", "delivery", "mode", "runId", "profile", "clientMetadata", "error", "failure", "notice",
        "providerId", "modelId", "senderAgentId", "senderAgentExplanation", "userId", "pipelineRun", "effort", "serviceTier", "permissionMode",
        "type", "text", "mimeType", "data", "attachment", "name", "kind", "thumbhash", "size", "width", "height", "durationMs", "scale",
        "arguments", "result", "presentation", "elevated", "review", "reason", "outcome", "risk", "userAuthorization", "before", "after", "beforeMessageId",
        "trigger", "tokensBefore", "tokensAfter", "startedAt", "completedAt", "failureReason", "operations", "target", "path", "query", "command",
        "output", "terminalId", "input", "files", "added", "deleted", "hunks", "newStart", "oldStart", "lines", "language", "omittedLines", "omittedFiles",
        "sources", "title", "url", "model", "agentId", "items", "layout", "columns", "root", "document", "artifactId", "version", "artifactType", "shows",
        "display", "questions", "header", "question", "multiSelect", "options", "label", "description", "answers", "source", "absolutePath",
    ]

    /// `id` if a report may carry it: one the server gave (never
    /// `AgentWire.Message.localId`'s), of the letters, digits, `-` and `_`
    /// server IDs are made of, at most 64 long.
    public static func reportable(_ id: String?) -> String? {
        guard let id, !id.isEmpty, id.utf8.count <= 64, !AgentWire.Message.isLocal(id),
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }) else { return nil }
        return id
    }

    private static let reported = Reported()

    /// Logs a message that failed, once per message: a history read and
    /// every update of it would otherwise say it again. The payload is
    /// never logged, only where it failed; the detail, which may quote it,
    /// is private.
    static func report(messageId: String, summary: String, detail: String) {
        guard reported.insert(messageId) else { return }
        let id = reportable(messageId) ?? "unnamed"
        #if canImport(OSLog)
        logger.error("Message \(id, privacy: .public) failed to display: \(summary, privacy: .public); \(detail, privacy: .private)")
        #else
        print("Message \(id) failed to display: \(summary)")
        #endif
    }

    /// Logs a presentation type this app doesn't know, once per type.
    static func report(unknownPresentation type: String) {
        guard reported.insert("presentation/\(type)") else { return }
        #if canImport(OSLog)
        logger.notice("Presentation \(type, privacy: .private) is unknown; shown as a plain tool call")
        #else
        print("Presentation \(type) is unknown; shown as a plain tool call")
        #endif
    }

    #if canImport(OSLog)
    private static let logger = Logger(subsystem: "app.happy", category: "MessageSchema")
    #endif

    private final class Reported: @unchecked Sendable {
        private let lock = NSLock()
        private var ids: Set<String> = []

        func insert(_ id: String) -> Bool { lock.withLock { ids.insert(id).inserted } }
    }
}
