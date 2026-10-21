import Foundation
import GRDB

/// Safe to include in a user-copied diagnostic report. Database errors can
/// contain SQL and record values; never retain their descriptions here.
public struct SessionDetailFailure: Equatable, Sendable {
    public enum Kind: String, Sendable { case database, decoding, storage }

    public let kind: Kind
    public let code: Int32?

    public init(kind: Kind, code: Int32? = nil) {
        self.kind = kind
        self.code = code
    }

    public init(_ error: any Error) {
        if let database = error as? DatabaseError {
            self.init(kind: .database, code: database.extendedResultCode.rawValue)
        } else if error is DecodingError || error is RowDecodingError {
            self.init(kind: .decoding)
        } else {
            self.init(kind: .storage)
        }
    }
}