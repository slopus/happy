import Foundation
import HappyStore
import HappyWire

func opsJSON<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONValue.decode(JSONEncoder().encode(value))
}

func opsDecode<T: Decodable>(_ value: JSONValue?) throws -> T {
    guard let value else { throw SessionOpsError.malformedResponse }
    return try value.decode(as: T.self)
}

func opsError(_ error: Error) -> String {
    if case SessionActionError.failed(let message) = error { return message }
    if case SessionOpsError.unavailable(let message) = error { return message }
    return (error as? LocalizedError)?.errorDescription ?? String(describing: error)
}

func opsVersion(_ value: JSONValue?) throws -> Int {
    guard let number = value?.numberValue, number.isFinite, number >= 0,
          number.rounded() == number, number < Double(Int.max) else { throw SessionOpsError.malformedResponse }
    return Int(number)
}

extension Dictionary where Key == String, Value == JSONValue {
    mutating func set(_ key: String, _ value: String?) {
        if let value { self[key] = .string(value) }
    }
}

enum SessionCapabilities {
    static func permits(_ metadata: JSONValue?, method: String) -> Bool {
        guard SessionMetadata.isRigV1(metadata) else { return true }
        guard metadata?["capabilities"]?["rpcMethods"]?.arrayValue?.contains(.string(method)) == true else { return false }
        switch method {
        case "abort": return metadata?["capabilities"]?["abort"]?.boolValue == true
        case "bash": return metadata?["capabilities"]?["shell"]?.boolValue == true
        case "readFile": return metadata?["capabilities"]?["files"]?["read"]?.boolValue == true
        case "writeFile": return metadata?["capabilities"]?["files"]?["write"]?.boolValue == true
        case "ripgrep": return metadata?["capabilities"]?["files"]?["search"]?.boolValue == true
        default: return true
        }
    }
}
