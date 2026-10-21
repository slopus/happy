import Foundation
import HappyWire

// The server runs Socket.IO 4 (Engine.IO protocol 4, Socket.IO protocol 5)
// over WebSocket only. These are the text packets that matter for a
// user-scoped client on the default namespace; binary packets are not used
// by Happy and are rejected.

/// The Engine.IO `open` packet payload.
public struct EngineIOHandshake: Codable, Equatable, Sendable {
    public var sid: String
    public var pingInterval: Int
    public var pingTimeout: Int
    public var maxPayload: Int?
}

public enum EngineIOPacket: Equatable, Sendable {
    case open(EngineIOHandshake)
    case close
    case ping
    case pong
    case message(String)
    case noop

    public init?(text: String) {
        guard let first = text.first else { return nil }
        let rest = String(text.dropFirst())
        switch first {
        case "0":
            guard let handshake = try? JSONDecoder().decode(EngineIOHandshake.self, from: Data(rest.utf8)) else { return nil }
            self = .open(handshake)
        case "1": self = .close
        case "2": self = .ping
        case "3": self = .pong
        case "4": self = .message(rest)
        case "6": self = .noop
        default: return nil
        }
    }

    public var text: String {
        switch self {
        case .open(let handshake):
            return "0" + String(decoding: (try? JSONEncoder().encode(handshake)) ?? Data(), as: UTF8.self)
        case .close: return "1"
        case .ping: return "2"
        case .pong: return "3"
        case .message(let payload): return "4" + payload
        case .noop: return "6"
        }
    }
}

public enum SocketIOPacket: Equatable, Sendable {
    /// Client → server carries the auth payload; server → client the sid.
    case connect(JSONValue?)
    case disconnect
    case event(name: String, arguments: [JSONValue], ackId: Int?)
    case ack(id: Int, arguments: [JSONValue])
    case connectError(JSONValue?)

    /// Parses the payload of an Engine.IO `message` packet. Packets for
    /// other namespaces and binary packets yield nil.
    public init?(text: String) {
        var chars = Substring(text)
        guard let type = chars.popFirst() else { return nil }

        if chars.first == "/" {
            guard let comma = chars.firstIndex(of: ",") else { return nil }
            guard chars[chars.startIndex..<comma] == "/" else { return nil }
            chars = chars[chars.index(after: comma)...]
        }

        var ackDigits = ""
        while let char = chars.first, char.isASCII, char.isNumber {
            ackDigits.append(char)
            chars = chars.dropFirst()
        }
        let ackId = Int(ackDigits)
        let json: JSONValue? = chars.isEmpty ? nil : try? JSONValue.decode(Data(chars.utf8))
        if !chars.isEmpty && json == nil { return nil }

        switch type {
        case "0":
            self = .connect(json)
        case "1":
            self = .disconnect
        case "2":
            guard case .array(let items)? = json, case .string(let name)? = items.first else { return nil }
            self = .event(name: name, arguments: Array(items.dropFirst()), ackId: ackId)
        case "3":
            guard let ackId, case .array(let items)? = json else { return nil }
            self = .ack(id: ackId, arguments: items)
        case "4":
            self = .connectError(json)
        default:
            return nil
        }
    }

    public var text: String {
        switch self {
        case .connect(let payload):
            return "0" + Self.encode(payload)
        case .disconnect:
            return "1"
        case .event(let name, let arguments, let ackId):
            return "2" + (ackId.map(String.init) ?? "") + Self.encode(.array([.string(name)] + arguments))
        case .ack(let id, let arguments):
            return "3\(id)" + Self.encode(.array(arguments))
        case .connectError(let payload):
            return "4" + Self.encode(payload)
        }
    }

    private static func encode(_ value: JSONValue?) -> String {
        guard let value, let string = try? value.encodedString() else { return "" }
        return string
    }
}

/// The WebSocket URL for a Happy server: origin + `/v1/updates/` with the
/// Engine.IO query. The server URL's own path is not used, matching
/// socket.io-client, which treats it as a namespace.
public enum SocketIOURL {
    public static func make(serverURL: URL, path: String = "/v1/updates/") -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else { return nil }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: return nil
        }
        components.path = path
        components.queryItems = [
            URLQueryItem(name: "EIO", value: "4"),
            URLQueryItem(name: "transport", value: "websocket"),
        ]
        components.fragment = nil
        return components.url
    }
}
