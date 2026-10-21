import Foundation
import GRDB
import HappyWire

/// JSON columns are stored as JSON text. Without this GRDB would encode a
/// top-level string or number as a bare SQLite value and decode it back
/// through SQLite's type affinity (text "v3" reads as `false`).
extension JSONValue: DatabaseValueConvertible {
    public var databaseValue: DatabaseValue {
        (try? encodedString())?.databaseValue ?? .null
    }

    public static func fromDatabaseValue(_ dbValue: DatabaseValue) -> JSONValue? {
        guard let text = String.fromDatabaseValue(dbValue) else { return nil }
        return try? JSONValue.decode(Data(text.utf8))
    }
}
