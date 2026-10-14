import Foundation

/// Prepares the shared account-storage root on a background executor. The
/// composition root supplies only its URL, including before any account exists.
enum AccountStorageDirectory {
    static func prepare(_ directory: URL?) throws {
        guard let directory else { return }
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if canImport(Darwin)
        // Account contents are recoverable; their decryption keys are device-only.
        var resourceURL = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try resourceURL.setResourceValues(values)
        #endif
    }
}