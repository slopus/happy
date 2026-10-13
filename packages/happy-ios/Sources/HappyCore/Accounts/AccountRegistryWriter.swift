import Foundation

/// One serial executor owns registry I/O. Revisions are allocated on the main
/// actor before submitting immutable values, so late tasks cannot restore an
/// older account selection or display. There is no suspension inside a write.
actor AccountRegistryWriter {
    typealias Save = @Sendable (AccountRegistry, URL?) throws -> Void
    private let saveValue: Save
    private var latestRevision: UInt64 = 0

    init(save: @escaping Save = { try $0.save(directory: $1) }) {
        saveValue = save
    }

    func load(directory: URL?) throws -> AccountRegistry {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        try AccountStorageDirectory.prepare(directory)
        return try AccountRegistry.load(directory: directory)
    }

    /// False means a later request has already reached the writer. A failed
    /// newer write also invalidates older requests; callers retry current state.
    @discardableResult
    func save(_ value: AccountRegistry, directory: URL?, revision: UInt64) throws -> Bool {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        guard revision > latestRevision else { return false }
        latestRevision = revision
        try AccountStorageDirectory.prepare(directory)
        try saveValue(value, directory)
        return true
    }
}