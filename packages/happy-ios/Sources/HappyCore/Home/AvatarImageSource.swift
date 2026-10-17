import Foundation
import HappyStore
import HappyWire

/// Account-local encrypted artwork identity. Contains no plaintext key or URL.
public struct AvatarImageSource: Hashable, Sendable {
    public enum Scope: String, Sendable { case session, project }
    public let scope: Scope
    public let id: String
    public let descriptor: AvatarDescriptor
    public let dataKeyCipher: String?

    public init(scope: Scope, id: String, descriptor: AvatarDescriptor, dataKeyCipher: String?) {
        self.scope = scope
        self.id = id
        self.descriptor = descriptor
        self.dataKeyCipher = dataKeyCipher
    }

    public var cacheKey: String {
        // Length-delimited JSON distinguishes refs, preview replacements and
        // key rotation, and is hashed before being used as a disk filename.
        (try? JSONEncoder().encode([scope.rawValue, id, descriptor.ref, String(descriptor.version), descriptor.preview, dataKeyCipher ?? ""]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    public static func project(_ project: ProjectRecord) -> Self? {
        project.avatar.map { .init(scope: .project, id: project.id, descriptor: $0, dataKeyCipher: project.dataKeyCipher) }
    }

    /// RN resolveSessionAvatar: session artwork wins. Only Happy Agent can
    /// inherit private project artwork; bots use the same precedence.
    public static func resolve(_ session: SessionRecord, project: ProjectRecord?) -> Self? {
        if let avatar = session.avatar {
            return .init(scope: .session, id: session.id, descriptor: avatar, dataKeyCipher: session.dataKeyCipher)
        }
        return session.isRig ? project.flatMap(Self.project) : nil
    }
}