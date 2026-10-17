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
    public let cacheKey: String
    struct ProjectFallback: Hashable, Sendable {
        let id: String
        let descriptor: AvatarDescriptor
        let dataKeyCipher: String?

        var source: AvatarImageSource {
            .init(scope: .project, id: id, descriptor: descriptor, dataKeyCipher: dataKeyCipher)
        }
    }
    var fallbackProject: ProjectFallback?

    public init(scope: Scope, id: String, descriptor: AvatarDescriptor, dataKeyCipher: String?) {
        self.scope = scope
        self.id = id
        self.descriptor = descriptor
        self.dataKeyCipher = dataKeyCipher
        self.fallbackProject = nil
        // Length-delimited JSON distinguishes refs, preview replacements and
        // key rotation. Derive once with row models off main, so configuring
        // a reused cell only performs the memory cache lookup.
        let identity = (try? JSONEncoder().encode([scope.rawValue, id, descriptor.ref, String(descriptor.version), descriptor.preview, dataKeyCipher ?? ""]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        self.cacheKey = PictureFiles.name(identity)
    }

    public static func project(_ project: ProjectRecord) -> Self? {
        project.avatar.map { .init(scope: .project, id: project.id, descriptor: $0, dataKeyCipher: project.dataKeyCipher) }
    }

    /// RN resolveSessionAvatar: session artwork wins. Only Happy Agent can
    /// inherit private project artwork; bots use the same precedence.
    public static func resolve(_ session: SessionRecord, project: ProjectRecord?) -> Self? {
        if let avatar = session.avatar {
            var source = Self(scope: .session, id: session.id, descriptor: avatar, dataKeyCipher: session.dataKeyCipher)
            if session.isRig, let project, let descriptor = project.avatar {
                source.fallbackProject = ProjectFallback(id: project.id, descriptor: descriptor, dataKeyCipher: project.dataKeyCipher)
            }
            return source
        }
        return session.isRig ? project.flatMap(Self.project) : nil
    }
}
