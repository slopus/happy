import Foundation

// Instance links (`happy://<instanceId>/…`) have no screen in happy-app;
// these are this app's own, the unknown-instance one in the edge SSO
// contract's words.
extension Strings {
    enum InstanceLinks {
        static let unknownTitle = "Can’t Open Link"
        static let unknown = "This link belongs to a Happy server you’re not connected to."
        static let notOpenedTitle = "Can’t Open Link"
        static let notOpened = "This link doesn’t say which Happy server it belongs to, so it can’t be opened from outside Happy."
        static let copyLink = "Copy Link"
        static let copied = "Link copied"
    }
}
